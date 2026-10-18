// CustomCommandManager: create/edit/enable custom commands.
import { useCallback, useState } from "react";
import clsx from "clsx";
import { Command } from "../types";
import { TAURI, invoke } from "../lib/tauri";
import { uid } from "../utils/text";

interface Props {
  commands: Command[];
  onChanged: () => void;
  onClose: () => void;
}

interface Editing {
  id: string;
  name: string;
  description: string;
  promptTemplate: string;
  enabled: boolean;
  modes: string; // comma-separated
}

const EMPTY: Editing = {
  id: "",
  name: "",
  description: "",
  promptTemplate: "",
  enabled: true,
  modes: "",
};

export function CustomCommandManager({ commands, onChanged, onClose }: Props) {
  const [editing, setEditing] = useState<Editing>(EMPTY);
  const [saving, setSaving] = useState(false);

  const startNew = useCallback(() => {
    setEditing({ ...EMPTY, id: uid("cmd-") });
  }, []);

  const startEdit = useCallback((c: Command) => {
    setEditing({
      id: c.id,
      name: c.name,
      description: c.description,
      promptTemplate: c.promptTemplate,
      enabled: c.enabled,
      modes: c.modes?.join(", ") ?? "",
    });
  }, []);

  const save = useCallback(async () => {
    if (!editing.name) return;
    setSaving(true);
    const cmd: Command = {
      id: editing.id || uid("cmd-"),
      name: editing.name.toLowerCase().replace(/[^a-z0-9_\-]/g, ""),
      description: editing.description,
      promptTemplate: editing.promptTemplate,
      kind: "custom",
      enabled: editing.enabled,
      modes: editing.modes
        ? editing
            .modes.split(",")
            .map((m) => m.trim())
            .filter(Boolean)
        : undefined,
      createdAt: new Date().toISOString(),
    };
    try {
      if (TAURI) await invoke("save_custom_command", { cmd });
      onChanged();
      setEditing(EMPTY);
    } finally {
      setSaving(false);
    }
  }, [editing, onChanged]);

  const remove = useCallback(
    async (c: Command) => {
      if (TAURI) {
        try {
          await invoke("delete_custom_command", { id: c.id });
          onChanged();
        } catch (e) {
          console.error(e);
        }
      }
    },
    [onChanged],
  );

  return (
    <div className="custom-cmds">
      <div className="settings-head">
        <h2>自定义命令</h2>
        <div className="spacer" />
        <button onClick={startNew} className="primary">新建</button>
        <button className="ghost" onClick={onClose}>返回</button>
      </div>

      <div className="settings-body custom-cmds-body">
        <section className="section">
          <h3>编辑器</h3>
          {editing.id && (
            <div className="editor">
              <div className="grid-2">
                <div className="field">
                  <label>名称</label>
                  <input
                    value={editing.name}
                    onChange={(e) => setEditing((s) => ({ ...s, name: e.target.value }))}
                    placeholder="mycommand"
                  />
                </div>
                <div className="field">
                  <label>描述</label>
                  <input
                    value={editing.description}
                    onChange={(e) => setEditing((s) => ({ ...s, description: e.target.value }))}
                    placeholder="简短描述"
                  />
                </div>
                <div className="field">
                  <label>模式（用英文逗号分隔，可选）</label>
                  <input
                    value={editing.modes}
                    onChange={(e) => setEditing((s) => ({ ...s, modes: e.target.value }))}
                    placeholder="如：更正式, 更简短"
                  />
                </div>
                <label className="row gap-8 toggle">
                  <input
                    type="checkbox"
                    checked={editing.enabled}
                    onChange={(e) => setEditing((s) => ({ ...s, enabled: e.target.checked }))}
                  />
                  启用该命令
                </label>
              </div>
              <div className="field">
                <label>提示词模板</label>
                <textarea
                  rows={14}
                  value={editing.promptTemplate}
                  onChange={(e) => setEditing((s) => ({ ...s, promptTemplate: e.target.value }))}
                  placeholder={"例如：你是一位简洁的语气检查员。用户的文字用 {{context}} 表示。"}
                />
                <span className="hint">
                  可用变量：<code>
                    {"{{context}} {{selection}} {{clipboard}} {{input}} {{language}} {{date}}"}
                  </code>
                </span>
              </div>
              <div className="row gap-8">
                <button className="primary" onClick={save} disabled={!editing.name || saving}>
                  {saving ? "保存中…" : "保存"}
                </button>
                <button className="ghost" onClick={() => setEditing(EMPTY)}>
                  取消
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="section">
          <h3>命令列表</h3>
          {commands.length === 0 && (
            <div className="dim">还没有自定义命令，点「新建」创建一个。</div>
          )}
          <div className="cmd-list">
            {commands.map((c) => (
              <div key={c.id} className={clsx("cmd-item", !c.enabled && "dim")}>
                <button
                  className="cmd-item-row"
                  onClick={() => startEdit(c)}
                >
                  <span className="cmd-item-name">/{c.name}</span>
                  <span className="cmd-item-desc dim">{c.description}</span>
                </button>
                <button className="ghost small" onClick={() => remove(c)} title="删除">
                  删除
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
