import { invoke } from "@tauri-apps/api/core";
import type {
  PersistedTranscript,
  TranscriptMeta,
  TranscriptStore,
} from "../../core/ports/transcriptStore";

/** Interface adapter — session-history persistence via the Rust backend. */
export class TauriTranscriptStore implements TranscriptStore {
  async save(projectPath: string, transcript: PersistedTranscript): Promise<void> {
    await invoke("save_session", {
      projectPath,
      id: transcript.id,
      json: JSON.stringify(transcript),
    });
  }

  async list(projectPath: string): Promise<TranscriptMeta[]> {
    return invoke<TranscriptMeta[]>("list_sessions", { projectPath });
  }

  async load(projectPath: string, id: string): Promise<PersistedTranscript | null> {
    const raw = await invoke<string | null>("load_session", { projectPath, id });
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PersistedTranscript;
    } catch {
      return null;
    }
  }

  async remove(projectPath: string, id: string): Promise<void> {
    await invoke("delete_session", { projectPath, id });
  }

  async readPlanFile(projectPath: string, path: string): Promise<string | null> {
    return invoke<string | null>("read_plan_file", { projectPath, path });
  }
}
