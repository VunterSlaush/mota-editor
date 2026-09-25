import { invoke } from "@tauri-apps/api/core";
import {
  type JevAnswers,
  judgeQuestions,
  type TurnJudgeInput,
  type TurnVerdict,
  turnVerdictFromAnswers,
} from "../../core/entities/jev";
import type { TurnJudge } from "../../core/ports/turnJudge";

/**
 * Interface adapter — judges a finished turn through the backend's
 * `jev_classify`. Any failure (no key, no curl, Jev down) is a turn left
 * unjudged, never an error the user has to see.
 */
export class TauriTurnJudge implements TurnJudge {
  async judge(input: TurnJudgeInput): Promise<TurnVerdict | null> {
    try {
      const answers = await invoke<JevAnswers>("jev_classify", {
        state: input,
        questions: judgeQuestions(),
      });
      return turnVerdictFromAnswers(answers);
    } catch {
      return null;
    }
  }
}
