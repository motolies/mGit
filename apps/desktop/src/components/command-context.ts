import { createContext } from 'react';
import type { Action } from '../actions';

/** 터미널 같은 공유 셸 UI에 현재 유효 명령을 전달한다. */
export const CommandContext = createContext<readonly Action[]>([]);
