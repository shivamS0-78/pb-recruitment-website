import { useState, useEffect } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { useProblemDetails } from '../hooks/useProblemDetails';
import { CodeProblemView } from '../components/CodeProblemView';
import { MCQProblemView } from '../components/MCQProblemView';
import { SubmittedSolutionViewer } from '../components/SubmittedSolutionViewer';
import { useProblemSubmissions } from '../hooks/useProblemSubmissions';
import type { ContestOutletContext } from '../layouts/ContestLayout';
import { contestApi, type SubmissionDetailsResponse } from '@/services/api/contestApi';
import { AlertCircle, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const ContestProblemPage = () => {
  const { contestId, problemId } = useParams<{ contestId: string; problemId: string }>();
  const navigate = useNavigate();
  const {
    isContestEnded = false,
    isAuthenticated = false,
    isRegistered = false,
  } = useOutletContext<ContestOutletContext>() || {};

  // For ended contests: only registered + authenticated users see code/submissions.
  // Guests and unregistered users see ONLY the problem statement (hideIDE = true).
  const hideIDE = isContestEnded ? !(isAuthenticated && isRegistered) : !isAuthenticated;
  const isLocked = isContestEnded;

  const { problem, isLoading, error } = useProblemDetails(contestId || '', problemId || '');

  // During active contest: load and poll submissions.
  // After contest ends: skip loading submission history completely to avoid redundant network calls.
  const {
    activeSubmission,
    history,
    historyError,
    isHistoryLoading,
    hasMoreHistory,
    submitCode,
    runCode,
    submitMCQ,
    retryPolling,
    refreshHistory,
    loadMoreHistory,
  } = useProblemSubmissions(contestId || '', problemId || '', {
    skip: !isAuthenticated || isContestEnded,
  });

  // State to hold the registered user's latest submitted solution details (including code)
  const [latestSubmission, setLatestSubmission] = useState<SubmissionDetailsResponse | null>(null);
  const [isLoadingSubmission, setIsLoadingSubmission] = useState(false);

  useEffect(() => {
    if (!isContestEnded || !isAuthenticated || !isRegistered || !problemId) {
      return;
    }

    const cacheKey = `submission_details_${problemId}`;

    // 1. Try reading from sessionStorage immediately (0ms, 0 network requests)
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const parsed: SubmissionDetailsResponse = JSON.parse(cached);
        if (parsed && (parsed.code || parsed.option)) {
          setLatestSubmission(parsed);
          return;
        }
      }
    } catch {
      // sessionStorage unavailable or parse error; continue to fetch
    }

    let isMounted = true;
    setIsLoadingSubmission(true);

    // Fetch user's latest submission directly
    contestApi
      .listUserSubmissions(problemId, 0)
      .then(async (submissions) => {
        if (!isMounted) return;
        if (!submissions || submissions.length === 0) {
          setLatestSubmission(null);
          return;
        }

        const firstSub = submissions[0];
        if (firstSub.code) {
          setLatestSubmission(firstSub);
          try {
            sessionStorage.setItem(cacheKey, JSON.stringify(firstSub));
          } catch {
            // ignore
          }
          return;
        }

        // Fetch full code details if not present in the list item
        try {
          const details = await contestApi.getSubmissionDetails(firstSub.id);
          if (!isMounted) return;
          setLatestSubmission(details);
          try {
            sessionStorage.setItem(cacheKey, JSON.stringify(details));
          } catch {
            // ignore
          }
        } catch {
          if (isMounted) setLatestSubmission(firstSub);
        }
      })
      .catch((err) => {
        console.error('Failed to load user submission for problem:', err);
      })
      .finally(() => {
        if (isMounted) setIsLoadingSubmission(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isContestEnded, isAuthenticated, isRegistered, problemId]);

  if (!contestId || !problemId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-4">
          <AlertCircle className="w-12 h-12 text-red-400 mx-auto" />
          <div className="text-red-400 font-['DM_Sans']">Invalid contest or problem ID</div>
          <Button
            onClick={() => navigate('/contests')}
            variant="outline"
            className="mt-4"
          >
            Back to Contests
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-4">
          <Loader2 className="w-12 h-12 text-[#10b981] animate-spin mx-auto" />
          <div className="text-gray-400 font-['DM_Sans']">Loading problem details...</div>
        </div>
      </div>
    );
  }

  if (error || !problem) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-4 max-w-md px-4">
          <AlertCircle className="w-12 h-12 text-red-400 mx-auto" />
          <div className="text-red-400 font-['DM_Sans'] text-lg">
            {error || 'Failed to load problem'}
          </div>
          <p className="text-gray-400 text-sm">
            The problem could not be loaded. Please try again or contact support if the issue
            persists.
          </p>
          <div className="flex gap-3 justify-center pt-4">
            <Button
              onClick={() => navigate(`/contests/${contestId}/problems`)}
              variant="outline"
            >
              Back to Problems
            </Button>
            <Button
              onClick={() => window.location.reload()}
              className="bg-[#16a34a] hover:bg-[#15803d]"
            >
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Derive option index for MCQ if submitted
  const submittedOptionIndex =
    latestSubmission?.option && latestSubmission.option.length > 0
      ? latestSubmission.option[0]
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#05070a]">
      {/* Informational banners when contest has ended */}
      {isContestEnded && !isAuthenticated && (
        <div className="flex items-center gap-2 px-4 py-2 bg-[#090d14] border-b border-[#1e2636] text-sm text-gray-300 flex-shrink-0">
          <Lock className="w-4 h-4 text-yellow-400 flex-shrink-0" />
          <span>
            This contest has ended.{' '}
            <button
              onClick={() => navigate('/login')}
              className="text-[#10b981] hover:underline"
            >
              Sign in
            </button>{' '}
            to view your contest details.
          </span>
        </div>
      )}

      {isContestEnded && isAuthenticated && !isRegistered && (
        <div className="flex items-center gap-2 px-4 py-2 bg-[#090d14] border-b border-[#1e2636] text-sm text-gray-300 flex-shrink-0">
          <Lock className="w-4 h-4 text-yellow-400 flex-shrink-0" />
          <span>
            This contest has ended. You were not registered for this contest, so only the problem statement is visible.
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {problem.type === 'code' ? (
          isContestEnded && isAuthenticated && isRegistered ? (
            /* Post-contest registered view: Exactly 50/50 uniform split */
            <div className="flex-1 flex min-h-0 overflow-hidden">
              <div className="w-1/2 min-h-0 border-r border-[#1e2636] overflow-hidden flex flex-col">
                <CodeProblemView
                  key={problem.id}
                  problem={problem}
                  isContestEnded={true}
                  hideIDE={true}
                  isLocked={true}
                />
              </div>
              <div className="w-1/2 min-h-0 overflow-hidden flex flex-col">
                <SubmittedSolutionViewer
                  submission={latestSubmission}
                  isLoading={isLoadingSubmission}
                />
              </div>
            </div>
          ) : (
            /* Active contest CodeChef-style 2-column workspace */
            <CodeProblemView
              key={problem.id}
              problem={problem}
              onSubmit={isAuthenticated && !isLocked ? submitCode : undefined}
              onRun={isAuthenticated && !isLocked ? runCode : undefined}
              isContestEnded={isContestEnded}
              hideIDE={hideIDE}
              isLocked={isLocked}
              activeSubmission={activeSubmission}
              history={history}
              historyError={historyError}
              isHistoryLoading={isHistoryLoading}
              hasMoreHistory={hasMoreHistory}
              onRetryPolling={retryPolling}
              onRefreshHistory={refreshHistory}
              onLoadMoreHistory={loadMoreHistory}
            />
          )
        ) : (
          <MCQProblemView
            key={problem.id}
            problem={problem}
            onSubmit={isAuthenticated && !isLocked ? submitMCQ : undefined}
            isContestEnded={isContestEnded}
            hideIDE={hideIDE}
            submittedOption={isContestEnded && isRegistered ? submittedOptionIndex : null}
          />
        )}
      </div>
    </div>
  );
};
