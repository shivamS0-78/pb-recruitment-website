import { useState, useCallback, useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import axios from 'axios';
import { Button } from '@/components/ui/button';
import {
  Play,
  Send,
  Copy,
  Check,
  Lock,
  RotateCcw,
  Maximize2,
  Minimize2,
  ChevronUp,
  ChevronDown,
  RefreshCw,
  Clock3,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  History,
  Terminal,
  FileText,
  Activity,
  ArrowUpRight,
} from 'lucide-react';
import type { Problem } from '../problem.types';
import type {
  RunCodeResponse,
  SubmissionDetailsResponse,
  TestCaseResult,
} from '@/services/api/contestApi';
import type { ActiveSubmission } from '../hooks/useProblemSubmissions';
import {
  formatVerdict,
  getVerdictClasses,
  formatSubmittedAt,
} from '../submissionUtils';

interface CodeProblemViewProps {
  problem: Problem;
  onSubmit?: (code: string, language: string) => Promise<void>;
  onRun?: (code: string, language: string, stdin: string) => Promise<RunCodeResponse>;
  isContestEnded?: boolean;
  /** hideIDE: unauthenticated visitors – only show problem statement, hide the editor pane */
  hideIDE?: boolean;
  /** isLocked: show the editor in read-only mode with no Run/Submit buttons */
  isLocked?: boolean;
  /** activeSubmission: live or latest judged submission state */
  activeSubmission?: ActiveSubmission;
  /** history: list of past submissions for this problem */
  history?: SubmissionDetailsResponse[];
  historyError?: string | null;
  isHistoryLoading?: boolean;
  hasMoreHistory?: boolean;
  onRetryPolling?: () => void;
  onRefreshHistory?: () => void;
  onLoadMoreHistory?: () => void;
}

const SUPPORTED_LANGUAGES = [
  { value: 'cpp', label: 'C++ 17', monacoValue: 'cpp' },
  { value: 'python', label: 'Python 3', monacoValue: 'python' },
  { value: 'java', label: 'Java 11', monacoValue: 'java' },
  { value: 'javascript', label: 'JavaScript', monacoValue: 'javascript' },
  { value: 'c', label: 'C', monacoValue: 'c' },
] as const;

const DEFAULT_CODE_TEMPLATES: Record<string, string> = {
  cpp: `#include <iostream>
using namespace std;

int main() {
    // Your code here
    return 0;
}`,
  python: `# Your code here
def main():
    pass

if __name__ == "__main__":
    main()`,
  java: `public class Main {
    public static void main(String[] args) {
        // Your code here
    }
}`,
  javascript: `// Your code here
function main() {
    
}

main();`,
  c: `#include <stdio.h>

int main() {
    // Your code here
    return 0;
}`,
};

const getRunErrorMessage = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 404) return 'Code execution is unavailable right now.';
    const responseData: unknown = error.response?.data;
    if (typeof responseData === 'object' && responseData !== null) {
      const data = responseData as Record<string, unknown>;
      if (typeof data.error === 'string') return data.error;
      if (typeof data.message === 'string') return data.message;
    }
    if (error.message) return error.message;
  }
  return error instanceof Error ? error.message : 'Code execution failed. Please try again.';
};

export const CodeProblemView = ({
  problem,
  onSubmit,
  onRun,
  
  hideIDE = false,
  isLocked = false,
  activeSubmission = { phase: 'idle' },
  history = [],
  historyError = null,
  isHistoryLoading = false,
  hasMoreHistory = false,
  onRetryPolling,
  onRefreshHistory,
  onLoadMoreHistory,
}: CodeProblemViewProps) => {
  // Language & Code state
  const [selectedLanguage, setSelectedLanguage] = useState('cpp');
  const [codeByLanguage, setCodeByLanguage] = useState<Record<string, string>>(
    () => ({ ...DEFAULT_CODE_TEMPLATES }),
  );
  const code = codeByLanguage[selectedLanguage] || '';

  // Left Pane State (Statement | Submissions | Latest Result)
  const [leftTab, setLeftTab] = useState<'statement' | 'submissions' | 'latest_result'>('statement');
  const [isLeftMaximized, setIsLeftMaximized] = useState(false);

  // Right Pane Console Drawer State (Input | Output | Latest Result)
  const [consoleTab, setConsoleTab] = useState<'input' | 'output' | 'latest_result'>('input');
  const [isConsoleCollapsed, setIsConsoleCollapsed] = useState(false);
  const [consoleHeight, setConsoleHeight] = useState(230);

  // Custom Input & Run state
  const [customInput, setCustomInput] = useState('');
  const [runResult, setRunResult] = useState<{
    status?: string;
    runtime?: number;
    memory?: number;
    stdout?: string;
    stderr?: string;
    compile_output?: string;
    errorText?: string;
  } | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Editor cursor tracking & clipboard feedback
  const [cursorPos, setCursorPos] = useState({ lineNumber: 1, column: 1 });
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Pane resizing
  const [leftPaneWidthPct, setLeftPaneWidthPct] = useState<number>(46);
  const [isResizingH, setIsResizingH] = useState(false);
  const [isResizingV, setIsResizingV] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const inputRevisionRef = useRef(0);

  const invalidateRun = useCallback(() => {
    inputRevisionRef.current += 1;
    setRunResult(null);
  }, []);

  const handleLanguageChange = useCallback((newLanguage: string) => {
    invalidateRun();
    setSelectedLanguage(newLanguage);
  }, [invalidateRun]);

  const handleCodeChange = useCallback((value: string | undefined) => {
    invalidateRun();
    setCodeByLanguage((current) => ({
      ...current,
      [selectedLanguage]: value || '',
    }));
  }, [invalidateRun, selectedLanguage]);

  const handleResetCode = useCallback(() => {
    if (isLocked) return;
    const defaultTemplate = DEFAULT_CODE_TEMPLATES[selectedLanguage] || '';
    handleCodeChange(defaultTemplate);
  }, [handleCodeChange, isLocked, selectedLanguage]);

  const handleCopy = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const handleLoadSampleIntoCustomInput = useCallback((input: string) => {
    setCustomInput(input);
    setConsoleTab('input');
    setIsConsoleCollapsed(false);
  }, []);

  // Run Code logic
  const handleRunCode = useCallback(async () => {
    if (!code.trim()) {
      setRunResult({ errorText: 'Code is empty.' });
      setConsoleTab('output');
      setIsConsoleCollapsed(false);
      return;
    }
    if (!onRun) {
      setRunResult({ errorText: 'Code execution is unavailable right now.' });
      setConsoleTab('output');
      setIsConsoleCollapsed(false);
      return;
    }

    setIsRunning(true);
    setConsoleTab('output');
    setIsConsoleCollapsed(false);
    setRunResult(null);
    const inputRevision = inputRevisionRef.current;

    try {
      const result = await onRun(code, selectedLanguage, customInput);
      if (inputRevision !== inputRevisionRef.current) return;
      setRunResult({
        status: result.status,
        runtime: result.runtime,
        memory: result.memory,
        stdout: result.stdout,
        stderr: result.stderr,
        compile_output: result.compile_output,
      });
    } catch (error) {
      if (inputRevision !== inputRevisionRef.current) return;
      setRunResult({ errorText: getRunErrorMessage(error) });
    } finally {
      setIsRunning(false);
    }
  }, [code, customInput, onRun, selectedLanguage]);

  // Submit Code logic
  const handleSubmit = async () => {
    if (!onSubmit) {
      console.log('Submitting code:', { code, language: selectedLanguage });
      return;
    }

    try {
      setIsSubmitting(true);
      // Automatically expand console and switch to Latest result
      setIsConsoleCollapsed(false);
      setConsoleTab('latest_result');
      await onSubmit(code, selectedLanguage);
    } catch (error) {
      console.error('Submission error:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Horizontal Pane Split Drag (Left vs Right)
  useEffect(() => {
    if (!isResizingH) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const bounds = containerRef.current.getBoundingClientRect();
      const relativeX = e.clientX - bounds.left;
      const pct = (relativeX / bounds.width) * 100;
      const clamped = Math.max(25, Math.min(72, pct));
      setLeftPaneWidthPct(clamped);
      setIsLeftMaximized(false);
    };

    const handleMouseUp = () => {
      setIsResizingH(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingH]);

  // Vertical Console Drawer Drag (Editor vs Drawer)
  useEffect(() => {
    if (!isResizingV) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!rightPaneRef.current) return;
      const bounds = rightPaneRef.current.getBoundingClientRect();
      const relativeY = bounds.bottom - e.clientY;
      const clamped = Math.max(80, Math.min(bounds.height - 120, relativeY));
      setConsoleHeight(clamped);
      if (isConsoleCollapsed) setIsConsoleCollapsed(false);
    };

    const handleMouseUp = () => {
      setIsResizingV(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isConsoleCollapsed, isResizingV]);

  const toggleMaximizeLeft = () => {
    if (isLeftMaximized) {
      setLeftPaneWidthPct(46);
      setIsLeftMaximized(false);
    } else {
      setLeftPaneWidthPct(68);
      setIsLeftMaximized(true);
    }
  };

  const sample1 = problem.examples && problem.examples.length > 0 ? problem.examples[0] : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[#05070a] text-slate-200 overflow-hidden font-['DM_Sans'] select-text">

      {/* Main Split Workspace Container */}
      <div
        ref={containerRef}
        id="workspaceContainer"
        className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden"
      >
        {/* ========================================================= */}
        {/* LEFT PANE: Tabbed Problem Context                         */}
        {/* ========================================================= */}
        <div
          className="flex flex-col min-h-0 overflow-hidden bg-[#090d14] border-r border-[#1e2636] flex-shrink-0"
          style={{ width: hideIDE ? '100%' : `${leftPaneWidthPct}%` }}
        >
          {/* Left Pane Top Tab Bar (40px) */}
          <div className="h-10 bg-[#0b0f17] border-b border-[#1e2636] flex items-center justify-between px-2 flex-shrink-0">
            <div className="flex items-center gap-1 h-full">
              {/* Tab 1: Statement */}
              <button
                type="button"
                onClick={() => setLeftTab('statement')}
                className={`relative px-3.5 h-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                  leftTab === 'statement'
                    ? 'text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Statement</span>
                {leftTab === 'statement' && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#10b981]" />
                )}
              </button>

              {/* Tab 2: Submissions */}
              {!hideIDE && (
                <button
                  type="button"
                  onClick={() => setLeftTab('submissions')}
                  className={`relative px-3.5 h-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                    leftTab === 'submissions'
                      ? 'text-white'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <History className="w-3.5 h-3.5" />
                  <span>Submissions</span>
                  {history.length > 0 && (
                    <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-[#141b29] text-[#10b981] border border-[#1e2636]">
                      {history.length}
                    </span>
                  )}
                  {leftTab === 'submissions' && (
                    <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#10b981]" />
                  )}
                </button>
              )}

              {/* Tab 3: Latest Result */}
              {!hideIDE && (
                <button
                  type="button"
                  onClick={() => setLeftTab('latest_result')}
                  className={`relative px-3.5 h-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                    leftTab === 'latest_result'
                      ? 'text-white'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <Activity className="w-3.5 h-3.5" />
                  <span>Latest Result</span>
                  {activeSubmission.status && (
                    <span className={`px-1.5 py-0.2 rounded text-[10px] font-semibold border ${getVerdictClasses(activeSubmission.status)}`}>
                      {formatVerdict(activeSubmission.status)}
                    </span>
                  )}
                  {leftTab === 'latest_result' && (
                    <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#10b981]" />
                  )}
                </button>
              )}
            </div>

            {/* Maximize / Restore width toggle */}
            {!hideIDE && (
              <button
                type="button"
                onClick={toggleMaximizeLeft}
                title={isLeftMaximized ? 'Restore Width' : 'Maximize Statement Width'}
                className="p-1.5 rounded hover:bg-[#141b29] text-gray-400 hover:text-white transition-colors"
              >
                {isLeftMaximized ? (
                  <Minimize2 className="w-3.5 h-3.5 text-[#10b981]" />
                ) : (
                  <Maximize2 className="w-3.5 h-3.5" />
                )}
              </button>
            )}
          </div>

          {/* Left Pane Content Area */}
          <div className="flex-1 overflow-y-auto p-5">
            {leftTab === 'statement' && (
              <div className="space-y-4 max-w-4xl mx-auto">
                {/* Header Row: Title & Metadata Badges */}
                <div className="pb-3 border-b border-[#192130] flex flex-wrap items-center justify-between gap-3">
                  <h1 className="text-xl font-bold text-white tracking-tight">
                    {problem.name}
                  </h1>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="px-2.5 py-1 rounded bg-[#10b981]/15 text-[#10b981] font-semibold border border-[#10b981]/30">
                      {problem.score} points
                    </span>
                    {problem.time_limit && (
                      <span
                        className="px-2.5 py-1 rounded bg-[#141b29] text-slate-300 font-mono border border-[#1e2636] flex items-center gap-1.5"
                        title="Time Limit per test case"
                      >
                        <span className="text-[10px] uppercase font-sans tracking-wide text-slate-400 font-medium">Time Limit:</span>
                        <span>{problem.time_limit} ms</span>
                      </span>
                    )}
                    {problem.memory_limit && (
                      <span
                        className="px-2.5 py-1 rounded bg-[#141b29] text-slate-300 font-mono border border-[#1e2636] flex items-center gap-1.5"
                        title="Memory / Size Limit per test case"
                      >
                        <span className="text-[10px] uppercase font-sans tracking-wide text-slate-400 font-medium">Memory Limit:</span>
                        <span>{problem.memory_limit} MB</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Unified Continuous Statement Container */}
                <div className="p-5 rounded-lg bg-[#0b1018] border border-[#192233] text-sm text-slate-200 leading-relaxed space-y-5">
                  {/* Problem Description */}
                  {problem.description && (
                    <div className="space-y-2">
                      <p className="whitespace-pre-line leading-relaxed text-slate-200">
                        {problem.description}
                      </p>
                    </div>
                  )}

                  {/* Input format */}
                  {problem.input_format && (
                    <div className="space-y-1.5">
                      <h3 className="text-sm font-semibold text-white">Input</h3>
                      <p className="text-xs text-slate-300 whitespace-pre-line font-mono bg-[#06080d] p-3 rounded border border-[#192233]">
                        {problem.input_format}
                      </p>
                    </div>
                  )}

                  {/* Output format */}
                  {problem.output_format && (
                    <div className="space-y-1.5">
                      <h3 className="text-sm font-semibold text-white">Output</h3>
                      <p className="text-xs text-slate-300 whitespace-pre-line font-mono bg-[#06080d] p-3 rounded border border-[#192233]">
                        {problem.output_format}
                      </p>
                    </div>
                  )}

                  {/* Constraints / Note */}
                  {problem.constraints && problem.constraints.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold text-white">Note</h3>
                      <ul className="space-y-1 text-xs text-slate-300">
                        {problem.constraints.map((constraint, index) => (
                          <li key={index} className="flex items-start gap-2">
                            <span className="text-[#10b981] mt-0.5">•</span>
                            <span className="font-mono">{constraint}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Sample 1 side-by-side blocks with Copy & Load buttons */}
                  {sample1 && (
                    <div className="border-t border-[#192233] pt-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wider text-[#10b981]">
                          Sample 1
                        </span>
                        {!hideIDE && (
                          <button
                            type="button"
                            onClick={() => handleLoadSampleIntoCustomInput(sample1.input)}
                            className="flex items-center gap-1 text-xs text-slate-400 hover:text-[#10b981] transition-colors"
                          >
                            <ArrowUpRight className="w-3.5 h-3.5" />
                            <span>Load into Custom Input</span>
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {/* Sample Input */}
                        <div className="rounded border border-[#192233] bg-[#06080d] overflow-hidden">
                          <div className="flex items-center justify-between px-3 py-1.5 bg-[#0e1422] border-b border-[#192233] text-xs">
                            <span className="text-slate-400 font-medium">Input</span>
                            <button
                              type="button"
                              onClick={() => handleCopy(sample1.input, 'sample-input-0')}
                              className="text-slate-400 hover:text-white transition-colors"
                            >
                              {copiedId === 'sample-input-0' ? (
                                <Check className="w-3.5 h-3.5 text-[#10b981]" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                          <pre className="p-3 text-xs font-mono text-slate-200 overflow-x-auto whitespace-pre">
                            {sample1.input}
                          </pre>
                        </div>

                        {/* Sample Output */}
                        <div className="rounded border border-[#192233] bg-[#06080d] overflow-hidden">
                          <div className="flex items-center justify-between px-3 py-1.5 bg-[#0e1422] border-b border-[#192233] text-xs">
                            <span className="text-slate-400 font-medium">Output</span>
                            <button
                              type="button"
                              onClick={() => handleCopy(sample1.output, 'sample-output-0')}
                              className="text-slate-400 hover:text-white transition-colors"
                            >
                              {copiedId === 'sample-output-0' ? (
                                <Check className="w-3.5 h-3.5 text-[#10b981]" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                          <pre className="p-3 text-xs font-mono text-slate-200 overflow-x-auto whitespace-pre">
                            {sample1.output}
                          </pre>
                        </div>
                      </div>

                      {sample1.explanation && (
                        <div className="text-xs text-slate-400 pt-1">
                          <span className="font-semibold text-slate-300">Explanation: </span>
                          <span>{sample1.explanation}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {leftTab === 'submissions' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-[#1e2636]">
                  <div className="flex items-center gap-2">
                    <History className="w-4 h-4 text-slate-400" />
                    <h2 className="text-sm font-semibold text-white">Submission History</h2>
                  </div>
                  <button
                    type="button"
                    onClick={onRefreshHistory}
                    disabled={isHistoryLoading}
                    className="p-1 rounded text-slate-400 hover:text-white hover:bg-[#141b29] transition-colors"
                    title="Refresh submission history"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isHistoryLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                {historyError && (
                  <div className="flex items-start gap-2 p-3 rounded bg-amber-950/20 border border-amber-800/40 text-xs text-amber-200">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{historyError}</span>
                  </div>
                )}

                {history.length === 0 && !isHistoryLoading && (
                  <div className="text-center py-12 text-slate-500 text-xs">
                    No submissions for this problem yet.
                  </div>
                )}

                {history.length > 0 && (
                  <div className="overflow-hidden rounded border border-[#1e2636] bg-[#0b1018]">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-[#0e1422] text-slate-400 uppercase text-[10px] tracking-wider border-b border-[#1e2636]">
                        <tr>
                          <th className="py-2.5 px-3">Status</th>
                          <th className="py-2.5 px-3">Score</th>
                          <th className="py-2.5 px-3">Time</th>
                          <th className="py-2.5 px-3">Memory</th>
                          <th className="py-2.5 px-3">Lang</th>
                          <th className="py-2.5 px-3">Submitted</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1e2636]">
                        {history.map((sub) => (
                          <tr key={sub.id} className="hover:bg-[#141b29]/50 transition-colors">
                            <td className="py-2.5 px-3">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${getVerdictClasses(sub.status)}`}>
                                {formatVerdict(sub.status)}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-slate-200 font-mono">
                              {sub.score !== undefined ? `${sub.score}` : '—'}
                            </td>
                            <td className="py-2.5 px-3 text-slate-300 font-mono">
                              {sub.runtime !== undefined ? `${sub.runtime} ms` : '—'}
                            </td>
                            <td className="py-2.5 px-3 text-slate-300 font-mono">
                              {sub.memory !== undefined ? `${sub.memory} KB` : '—'}
                            </td>
                            <td className="py-2.5 px-3 text-slate-400 font-mono text-[11px]">
                              {sub.language || 'Code'}
                            </td>
                            <td className="py-2.5 px-3 text-slate-500 text-[11px]">
                              {formatSubmittedAt(sub.created_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {hasMoreHistory && (
                  <div className="text-center pt-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isHistoryLoading}
                      onClick={onLoadMoreHistory}
                      className="text-xs text-black"
                    >
                      {isHistoryLoading ? 'Loading…' : 'Load more'}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {leftTab === 'latest_result' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between pb-2 border-b border-[#1e2636]">
                  <h2 className="text-sm font-semibold text-white">Latest Result</h2>
                  {activeSubmission.status && (
                    <span className={`px-2.5 py-1 rounded text-xs font-semibold border ${getVerdictClasses(activeSubmission.status)}`}>
                      {formatVerdict(activeSubmission.status)}
                    </span>
                  )}
                </div>

                {activeSubmission.phase === 'idle' && !activeSubmission.details && (
                  <div className="border border-dashed border-[#1e2636] rounded-lg p-8 text-center text-xs text-slate-500">
                    Submit an answer to see its verdict here.
                  </div>
                )}

                {activeSubmission.phase !== 'idle' && (
                  <div className="space-y-4">
                    {/* Status card */}
                    <div className="flex items-start gap-3 p-4 rounded-lg bg-[#0b1018] border border-[#192233]">
                      {activeSubmission.status && ['accepted', 'completed'].includes(activeSubmission.status) ? (
                        <CheckCircle2 className="w-5 h-5 text-[#10b981] shrink-0 mt-0.5" />
                      ) : activeSubmission.phase === 'polling' || activeSubmission.phase === 'submitting' ? (
                        <div className="w-5 h-5 rounded-full border-2 border-[#10b981] border-t-transparent animate-spin shrink-0 mt-0.5" />
                      ) : activeSubmission.phase === 'timeout' ? (
                        <Clock3 className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-white">
                          {activeSubmission.phase === 'submitting' && 'Sending submission…'}
                          {activeSubmission.phase === 'received' && 'Submission received'}
                          {activeSubmission.phase === 'polling' && 'Judging in progress…'}
                          {activeSubmission.phase === 'completed' && formatVerdict(activeSubmission.status)}
                          {activeSubmission.phase === 'timeout' && 'Verdict delayed'}
                          {activeSubmission.phase === 'error' && 'Execution error'}
                        </p>
                        {activeSubmission.message && (
                          <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                            {activeSubmission.message}
                          </p>
                        )}
                      </div>
                      {onRetryPolling && Boolean(activeSubmission.id) && (activeSubmission.phase === 'timeout' || activeSubmission.phase === 'error') && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={onRetryPolling}
                          className="text-xs text-black"
                        >
                          Check again
                        </Button>
                      )}
                    </div>

                    {/* Execution stats */}
                    {activeSubmission.details && (
                      <div className="grid grid-cols-3 gap-2">
                        <div className="p-3 rounded bg-[#0b1018] border border-[#192233]">
                          <span className="text-[10px] text-slate-500 uppercase font-semibold">Runtime</span>
                          <p className="text-sm font-mono text-slate-200 mt-0.5">
                            {activeSubmission.details.runtime !== undefined ? `${activeSubmission.details.runtime} ms` : '—'}
                          </p>
                        </div>
                        <div className="p-3 rounded bg-[#0b1018] border border-[#192233]">
                          <span className="text-[10px] text-slate-500 uppercase font-semibold">Memory</span>
                          <p className="text-sm font-mono text-slate-200 mt-0.5">
                            {activeSubmission.details.memory !== undefined ? `${activeSubmission.details.memory} KB` : '—'}
                          </p>
                        </div>
                        <div className="p-3 rounded bg-[#0b1018] border border-[#192233]">
                          <span className="text-[10px] text-slate-500 uppercase font-semibold">Score</span>
                          <p className="text-sm font-mono text-[#10b981] mt-0.5 font-semibold">
                            {activeSubmission.details.score !== undefined ? `${activeSubmission.details.score}` : '0'}
                            {activeSubmission.details.max_score ? ` / ${activeSubmission.details.max_score}` : ''}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Test cases list */}
                    {activeSubmission.details?.test_case_results && activeSubmission.details.test_case_results.length > 0 && (
                      <div className="rounded border border-[#192233] bg-[#0b1018] overflow-hidden">
                        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-2 bg-[#0e1422] text-[10px] text-slate-400 uppercase font-semibold border-b border-[#192233]">
                          <span>Test Case</span>
                          <span>Verdict</span>
                          <span>Time</span>
                          <span>Memory</span>
                        </div>
                        <div className="divide-y divide-[#192233]">
                          {activeSubmission.details.test_case_results.map((tc: TestCaseResult, idx: number) => {
                            const isPass = ['pass', 'passed'].includes(tc.status);
                            return (
                              <div key={idx} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-2 text-xs items-center">
                                <span className="text-slate-300 font-mono">Case {idx + 1}</span>
                                <span className={isPass ? 'text-[#10b981] font-medium' : 'text-rose-400 font-medium'}>
                                  {isPass ? 'Passed' : formatVerdict(tc.status)}
                                </span>
                                <span className="text-slate-400 font-mono">{tc.runtime ?? '—'} ms</span>
                                <span className="text-slate-400 font-mono">{tc.memory ?? '—'} KB</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ========================================================= */}
        {/* VERTICAL DRAG RESIZER (Left vs Right)                     */}
        {/* ========================================================= */}
        {!hideIDE && (
          <div
            onMouseDown={() => setIsResizingH(true)}
            className="hidden md:flex w-[5px] cursor-col-resize hover:bg-[#10b981] active:bg-[#10b981] bg-[#1e2636] transition-colors flex-shrink-0 z-10"
            title="Drag to resize split"
          />
        )}

        {/* ========================================================= */}
        {/* RIGHT PANE: CodeChef-Style IDE & Collapsible Drawer       */}
        {/* ========================================================= */}
        {!hideIDE && (
          <div
            ref={rightPaneRef}
            className="flex-1 flex flex-col min-h-0 min-w-[320px] overflow-hidden bg-[#090d14]"
          >
            {/* Top Toolbar (48px) */}
            <div className="h-12 bg-[#0b0f17] border-b border-[#1e2636] px-4 flex items-center justify-between flex-shrink-0">
              {/* Left side: Language selector & helpers */}
              <div className="flex items-center gap-2">
                <select
                  value={selectedLanguage}
                  onChange={(e) => handleLanguageChange(e.target.value)}
                  disabled={isLocked}
                  className="bg-[#141b29] border border-[#28354d] text-white rounded px-3 py-1.5 text-xs focus:outline-none focus:border-[#10b981] font-mono cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <option key={lang.value} value={lang.value}>
                      {lang.label}
                    </option>
                  ))}
                </select>

                {!isLocked && (
                  <button
                    type="button"
                    onClick={handleResetCode}
                    title="Reset to default template"
                    className="p-1.5 rounded hover:bg-[#141b29] text-gray-400 hover:text-white transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleCopy(code, 'editor-code')}
                  title="Copy code"
                  className="p-1.5 rounded hover:bg-[#141b29] text-gray-400 hover:text-white transition-colors"
                >
                  {copiedId === 'editor-code' ? (
                    <Check className="w-3.5 h-3.5 text-[#10b981]" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              {/* Right side: Action buttons */}
              {isLocked ? (
                <div className="flex items-center gap-1.5 text-xs text-yellow-400 bg-yellow-400/10 border border-yellow-400/30 px-3 py-1 rounded">
                  <Lock className="w-3.5 h-3.5" />
                  <span>Contest Ended · Read Only</span>
                </div>
              ) : (
                <div className="flex items-center gap-2.5">
                  <Button
                    onClick={handleRunCode}
                    disabled={isRunning || !code.trim()}
                    size="sm"
                    className="h-8 px-3.5 text-xs font-semibold bg-[#ffffff] hover:bg-slate-200 text-[#090d14] flex items-center gap-1.5 shadow-sm transition-all"
                  >
                    {isRunning ? (
                      <>
                        <div className="animate-spin rounded-full h-3 w-3 border-2 border-[#090d14] border-t-transparent" />
                        <span>Running…</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-[#090d14]" />
                        <span>Run</span>
                      </>
                    )}
                  </Button>

                  <Button
                    onClick={handleSubmit}
                    disabled={isSubmitting}
                    size="sm"
                    className="h-8 px-4 text-xs font-semibold bg-[#16a34a] hover:bg-[#15803d] text-white flex items-center gap-1.5 shadow-sm transition-all"
                  >
                    {isSubmitting ? (
                      <>
                        <div className="animate-spin rounded-full h-3 w-3 border-2 border-white border-t-transparent" />
                        <span>Submitting…</span>
                      </>
                    ) : (
                      <>
                        <Send className="w-3.5 h-3.5" />
                        <span>Submit</span>
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>

            {/* Monaco Editor Container */}
            <div id="editorWrapper" className="flex-1 min-h-0 bg-[#1b1c1e] relative overflow-hidden">
              <Editor
                height="100%"
                language={
                  SUPPORTED_LANGUAGES.find((l) => l.value === selectedLanguage)
                    ?.monacoValue || 'cpp'
                }
                theme="vs-dark"
                value={code}
                onChange={handleCodeChange}
                onMount={(editor) => {
                  editor.onDidChangeCursorPosition((e: { position: { lineNumber: number; column: number } }) => {
                    setCursorPos({
                      lineNumber: e.position.lineNumber,
                      column: e.position.column,
                    });
                  });
                }}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: 'on',
                  lineNumbersMinChars: 4,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 4,
                  wordWrap: 'on',
                  padding: { top: 12, bottom: 12 },
                  readOnly: isLocked,
                  domReadOnly: isLocked,
                  fontFamily: "'Fira Code', 'JetBrains Mono', Menlo, Consolas, monospace",
                }}
              />
            </div>

            {/* Horizontal Drag Resizer (Editor vs Console Drawer) */}
            <div
              onMouseDown={() => setIsResizingV(true)}
              className="h-[5px] cursor-row-resize bg-[#1e2636] hover:bg-[#10b981] active:bg-[#10b981] transition-colors flex-shrink-0 z-10"
              title="Drag to resize console drawer"
            />

            {/* Collapsible Bottom Console Drawer */}
            <div
              className="flex flex-col bg-[#090d14] border-t border-[#1e2636] overflow-hidden flex-shrink-0 transition-[height] duration-150 ease-out"
              style={{ height: isConsoleCollapsed ? '36px' : `${consoleHeight}px` }}
            >
              {/* Console Header Bar (36px) */}
              <div className="h-9 bg-[#0b0f17] border-b border-[#1e2636] px-3 flex items-center justify-between flex-shrink-0">
                {/* Left side: Console Tabs */}
                <div className="flex items-center gap-1 h-full">
                  <button
                    type="button"
                    onClick={() => {
                      setConsoleTab('input');
                      if (isConsoleCollapsed) setIsConsoleCollapsed(false);
                    }}
                    className={`relative px-3 h-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                      consoleTab === 'input' && !isConsoleCollapsed
                        ? 'text-white'
                        : 'text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    <Terminal className="w-3.5 h-3.5" />
                    <span>Input</span>
                    {consoleTab === 'input' && !isConsoleCollapsed && (
                      <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#10b981]" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setConsoleTab('output');
                      if (isConsoleCollapsed) setIsConsoleCollapsed(false);
                    }}
                    className={`relative px-3 h-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                      consoleTab === 'output' && !isConsoleCollapsed
                        ? 'text-white'
                        : 'text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    <span>Output</span>
                    {runResult && (
                      <span className={`w-2 h-2 rounded-full ${runResult.status === 'accepted' ? 'bg-[#10b981]' : 'bg-rose-500'}`} />
                    )}
                    {consoleTab === 'output' && !isConsoleCollapsed && (
                      <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#10b981]" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setConsoleTab('latest_result');
                      if (isConsoleCollapsed) setIsConsoleCollapsed(false);
                    }}
                    className={`relative px-3 h-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                      consoleTab === 'latest_result' && !isConsoleCollapsed
                        ? 'text-white'
                        : 'text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    <span>Latest Result</span>
                    {activeSubmission.status && (
                      <span className={`px-1.5 py-0.2 rounded text-[10px] font-semibold border ${getVerdictClasses(activeSubmission.status)}`}>
                        {formatVerdict(activeSubmission.status)}
                      </span>
                    )}
                    {consoleTab === 'latest_result' && !isConsoleCollapsed && (
                      <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#10b981]" />
                    )}
                  </button>
                </div>

                {/* Right side: Cursor & Collapse Controls */}
                <div className="flex items-center gap-3 text-xs text-gray-400 font-mono">
                  <span className="hidden sm:inline text-[11px] text-gray-500">
                    Ln {cursorPos.lineNumber}, Col {cursorPos.column}
                  </span>

                  <button
                    type="button"
                    onClick={() => setIsConsoleCollapsed(!isConsoleCollapsed)}
                    className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-white transition-colors"
                  >
                    <span>{isConsoleCollapsed ? 'Show Console' : 'Hide Console'}</span>
                    {isConsoleCollapsed ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>

              {/* Console Body */}
              {!isConsoleCollapsed && (
                <div className="flex-1 min-h-0 overflow-hidden p-3 bg-[#090d14]">
                  {consoleTab === 'input' && (
                    <div className="h-full flex flex-col space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <label className="font-semibold text-slate-300">Custom Input:</label>
                        {sample1 && (
                          <button
                            type="button"
                            onClick={() => handleLoadSampleIntoCustomInput(sample1.input)}
                            className="text-[#10b981] hover:underline text-[11px]"
                          >
                            Use Sample Input
                          </button>
                        )}
                      </div>
                      <textarea
                        value={customInput}
                        onChange={(e) => {
                          if (isLocked) return;
                          invalidateRun();
                          setCustomInput(e.target.value);
                        }}
                        placeholder={isLocked ? 'Editor is locked (contest ended)' : 'Enter your custom input here...'}
                        disabled={isLocked}
                        className="flex-1 bg-[#141b29] border border-[#243047] rounded p-2.5 text-xs font-mono text-white focus:outline-none focus:border-[#10b981] resize-none leading-relaxed disabled:opacity-60 disabled:cursor-not-allowed"
                      />
                    </div>
                  )}

                  {consoleTab === 'output' && (
                    <div className="h-full flex flex-col overflow-auto font-mono text-xs space-y-2">
                      {isRunning ? (
                        <div className="flex-1 flex items-center justify-center gap-2 text-slate-400">
                          <div className="w-4 h-4 border-2 border-[#10b981] border-t-transparent rounded-full animate-spin" />
                          <span>Running code against custom input…</span>
                        </div>
                      ) : runResult ? (
                        <div className="space-y-2.5">
                          {/* Stats header */}
                          <div className="flex flex-wrap items-center gap-3 pb-2 border-b border-[#1e2636]">
                            <span className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${runResult.status === 'accepted' ? 'border-[#10b981]/50 bg-[#10b981]/15 text-[#10b981]' : 'border-rose-500/50 bg-rose-500/15 text-rose-300'}`}>
                              {runResult.status ? formatVerdict(runResult.status) : (runResult.errorText ? 'Error' : 'Finished')}
                            </span>
                            {runResult.runtime !== undefined && (
                              <span className="text-slate-400">Runtime: <strong className="text-white">{runResult.runtime} ms</strong></span>
                            )}
                            {runResult.memory !== undefined && (
                              <span className="text-slate-400">Memory: <strong className="text-white">{runResult.memory} KiB</strong></span>
                            )}
                          </div>

                          {/* Compile error */}
                          {runResult.compile_output?.trim() && (
                            <div className="space-y-1">
                              <span className="text-rose-400 text-[11px] uppercase font-semibold">Compiler Output:</span>
                              <pre className="p-2 rounded bg-black/60 border border-rose-900/40 text-rose-300 overflow-x-auto whitespace-pre">
                                {runResult.compile_output}
                              </pre>
                            </div>
                          )}

                          {/* Stderr */}
                          {runResult.stderr?.trim() && (
                            <div className="space-y-1">
                              <span className="text-rose-400 text-[11px] uppercase font-semibold">Standard Error:</span>
                              <pre className="p-2 rounded bg-black/60 border border-rose-900/40 text-rose-300 overflow-x-auto whitespace-pre">
                                {runResult.stderr}
                              </pre>
                            </div>
                          )}

                          {/* Error text */}
                          {runResult.errorText && (
                            <pre className="p-2 rounded bg-black/60 border border-rose-900/40 text-rose-300 overflow-x-auto whitespace-pre">
                              {runResult.errorText}
                            </pre>
                          )}

                          {/* Standard Output */}
                          {runResult.stdout !== undefined && (
                            <div className="space-y-1">
                              <span className="text-slate-400 text-[11px] uppercase font-semibold">Standard Output:</span>
                              <pre className="p-2.5 rounded bg-black/60 border border-[#1e2636] text-[#10b981] overflow-x-auto whitespace-pre">
                                {runResult.stdout || '(Program completed without output)'}
                              </pre>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex-1 flex items-center justify-center text-slate-500 text-xs">
                          Click "Run" to test your code against custom input.
                        </div>
                      )}
                    </div>
                  )}

                  {consoleTab === 'latest_result' && (
                    <div className="h-full overflow-y-auto space-y-3 font-mono text-xs">
                      {activeSubmission.phase === 'idle' && !activeSubmission.details ? (
                        <div className="border border-dashed border-[#1e2636] rounded p-6 text-center text-slate-500">
                          Submit an answer to see its verdict here.
                        </div>
                      ) : (
                        <div className="space-y-2.5">
                          <div className="flex items-center justify-between pb-2 border-b border-[#1e2636]">
                            <div className="flex items-center gap-2">
                              <span className="text-slate-300 font-semibold">Verdict:</span>
                              {activeSubmission.status && (
                                <span className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${getVerdictClasses(activeSubmission.status)}`}>
                                  {formatVerdict(activeSubmission.status)}
                                </span>
                              )}
                            </div>
                            {activeSubmission.details?.score !== undefined && (
                              <span className="text-[#10b981] font-semibold">
                                Score: {activeSubmission.details.score}
                                {activeSubmission.details.max_score ? ` / ${activeSubmission.details.max_score}` : ''}
                              </span>
                            )}
                          </div>

                          {activeSubmission.message && (
                            <p className="text-xs text-slate-400 font-sans leading-relaxed">
                              {activeSubmission.message}
                            </p>
                          )}

                          {activeSubmission.details && (
                            <div className="flex items-center gap-4 text-slate-400 text-xs">
                              <span>Time: <strong className="text-white">{activeSubmission.details.runtime ?? '—'} ms</strong></span>
                              <span>Memory: <strong className="text-white">{activeSubmission.details.memory ?? '—'} KB</strong></span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
