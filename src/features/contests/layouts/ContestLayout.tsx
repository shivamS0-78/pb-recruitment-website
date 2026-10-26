import { Outlet, useParams } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { ContestHeader } from '../components/ContestHeader';
import { useContest } from '../hooks/useContest';
import { useAuth } from '@/lib/AuthContext';
import type { Contest } from '../problem.types';

export interface ContestOutletContext {
  contest: Contest | null;
  timeRemaining: number;
  isContestEnded: boolean;
  isAuthenticated: boolean;
  isRegistered: boolean;
}

export const ContestLayout = () => {
  const { contestId } = useParams<{ contestId: string }>();
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [progress, setProgress] = useState(0);
  const { user } = useAuth();
  
  const { contest, isLoading: isContestLoading } = useContest(contestId || '');

  useEffect(() => {
    if (!contest) return;

    const updateTime = () => {
      const now = Date.now();
      const endTime = contest.end_time;
      const startTime = contest.start_time;
      const totalDuration = endTime - startTime;
      
      if (now >= endTime) {
        setTimeRemaining(0);
        setProgress(100);
        return;
      }

      const remaining = Math.floor((endTime - now) / 1000); // in seconds
      const elapsed = now - startTime;
      const progressPercentage = (elapsed / totalDuration) * 100;

      setTimeRemaining(Math.max(0, remaining));
      setProgress(Math.min(100, Math.max(0, progressPercentage)));
    };

    updateTime();

    const interval = setInterval(updateTime, 1000);

    return () => clearInterval(interval);
  }, [contest]);

  if (!contestId) {
    return (
      <div className="w-full bg-black min-h-screen flex flex-col">
        <ContestHeader 
          timeRemaining={0}
          progress={0}
          contestName="Invalid Contest"
        />
        <div className="px-6 py-6">
          <div className="text-red-400">Invalid contest ID</div>
        </div>
      </div>
    );
  }

  if (isContestLoading) {
    return (
      <div className="w-full bg-black min-h-screen flex flex-col">
        <ContestHeader 
          timeRemaining={0}
          progress={0}
          contestName="Loading..."
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-gray-400">Loading contest...</div>
        </div>
      </div>
    );
  }

  const isContestEnded = contest ? Date.now() >= contest.end_time : false;

  return (
    <div className="w-full bg-black h-screen flex flex-col overflow-hidden">
      <ContestHeader 
        timeRemaining={timeRemaining}
        progress={progress}
        contestName={contest?.name || 'Contest'}
        contestId={contestId}
      />
      
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <Outlet context={{ contest, timeRemaining, isContestEnded, isAuthenticated: !!user, isRegistered: contest?.is_registered ?? false } satisfies ContestOutletContext} />
      </div>
    </div>
  );
};

