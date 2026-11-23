import { useEffect, useState } from 'react';

/**
 * 현재 시각(epoch ms)을 `intervalMs` 마다 갱신해 돌려준다. 상대 날짜("N분 전")가 화면에 떠 있는 동안
 * 낡지 않게 하는 용도다. 타이머는 이 훅을 부른 곳에 하나만 생기므로 행마다 부르지 않는다
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
