// ExportImport: single-file backup of settings / model presets / notes /
// custom commands. API key and history are deliberately excluded.
// Schema: { schema: "aibar-export/v1", exportedAt, settings, model: {presets, activePresetId}, notes, customCommands }
import { useCallback, useState } from "react";
import { TAURI, invoke } from "../lib/tauri";
import { isTauri, invoke as tInvoke } from "@tauri-apps/api/core";
import { getSettings } from "../stores/settings";
import { getPresets } from "../stores/presets";
import { saveModelConfig } from "../stores/modelConfig";
import type { AppSettings, Command, Note } from "../types";

interface Props {
  onImported?: () => void;
}

const SCHEMA = "aibar-export/v1";

export function ExportImport({ onImported }: Props) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pendingImport, setPendingImport] = useState<string | null>(null);

  const doExport = useCallback(async () => {
    if (!isTauri()) return setMsg({ ok: false, text: "导出仅在桌面端可用。" });
    setBusy(true);
    setMsg(null);
    try {
      const settings = getSettings();
      const presets = getPresets();
      const notes = (await invoke<Partial<Note>[]>("list_notes").catch(() => [])) ?? [];
      const customs =
        (await invoke<Record<string, unknown>[]>("list_custom_commands").catch(() => [])) ?? [];
      const payload = {
        schema: SCHEMA,
        exportedAt: new Date().toISOString(),
        settings,
        model: {
          presets: presets.presets,
          activePresetId: presets.activePresetId,
        },
        notes,
        customCommands: customs,
      };
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `aibar-export-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return setMsg({ ok: false, text: "已取消。" });
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, new TextEncoder().encode(JSON.stringify(payload, null, 2)));
      setMsg({ ok: true, text: `已导出到 ${path}` });
    } catch (e) {
      setMsg({ ok: false, text: `导出失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, []);

  const doPickImport = useCallback(async () => {
    if (!isTauri()) return setMsg({ ok: false, text: "导入仅在桌面端可用。" });
    setBusy(true);
    setMsg(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = (await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      })) as string | null;
      if (!path) return;
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const raw = await readFile(path);
      const text = new TextDecoder().decode(raw);
      // Ask for confirmation before applying.
      setPendingImport(text);
    } catch (e) {
      setMsg({ ok: false, text: `读取失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, []);

  const applyImport = useCallback(async () => {
    if (!TAURI || !pendingImport) return;
    try {
      const data = JSON.parse(pendingImport);
      if (data.schema !== SCHEMA) {
        throw new Error(`不认识的导出格式（schema: ${data.schema ?? "缺失"}）`);
      }
      if (data.settings) {
        await invoke("save_settings", { settings: { ...data.settings, apiKey: undefined } });
        // 前端 store 也同步一次（加兼容字段默认值）
        const { saveSettings } = await import("../stores/settings");
        await saveSettings(data.settings as Partial<AppSettings>);
      }
      if (data.model) {
        for (const p of data.model.presets ?? []) {
          const { addPreset } = await import("../stores/presets");
          await addPreset(p);
        }
        if (data.model.activePresetId) {
          const { setActivePreset } = await import("../stores/presets");
          await setActivePreset(data.model.activePresetId);
          await saveModelConfig({ activePresetId: data.model.activePresetId });
        }
      }
      for (const n of data.notes ?? []) {
        await invoke("save_note", { note: n });
      }
      for (const c of data.customCommands ?? []) {
        await invoke("save_custom_command", { cmd: c });
      }
      setMsg({
        ok: true,
        text: `导入成功：${(data.notes ?? []).length} 条笔记、${
          (data.customCommands as Command[] | undefined)?.length ?? 0
        } 条自定义命令、${(data.model?.presets ?? []).length} 个预设。`,
      });
      setPendingImport(null);
      onImported?.();
    } catch (e) {
      setMsg({ ok: false, text: `导入失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }, [pendingImport, onImported]);

  return (
    <div className="field">
      <label>导入 / 导出</label>
      <p className="hint">
        单文件备份：设置、模型预设、笔记、自定义命令。
        <b> 不包含</b> API 密钥（仍在系统凭据库）和历史记录。
      </p>
      <div className="row gap-8">
        <button className="ghost" onClick={() => void doExport()} disabled={busy}>
          导出…
        </button>
        <button
          className="ghost"
          onClick={
            pendingImport
              ? () => void applyImport()
              : () => void doPickImport()
          }
          disabled={busy}
        >
          {pendingImport ? "确认导入" : "导入…"}
        </button>
        {pendingImport && (
          <button className="ghost danger" onClick={() => setPendingImport(null)}>
            取消
          </button>
        )}
      </div>
      {msg && (
        <div className={msg.ok ? "test-result ok" : "test-result err"}>{msg.text}</div>
      )}
    </div>
  );
}
