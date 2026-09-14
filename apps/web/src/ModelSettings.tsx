import { useEffect, useState, type FormEvent } from "react";
import {
  clearModelConfig,
  readModelConfig,
  validateModelConfig,
  writeModelConfig,
  type ModelConfig,
} from "./model-config.js";

interface ModelSettingsProps {
  onConfigChange: (config: ModelConfig | null) => void;
}

export function ModelSettings({ onConfigChange }: ModelSettingsProps) {
  const [form, setForm] = useState<ModelConfig>({ baseUrl: "", apiKey: "", model: "" });
  const [saved, setSaved] = useState<ModelConfig | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const config = readModelConfig();
    if (config) {
      setForm(config);
      setSaved(config);
    }
    onConfigChange(config);
  }, [onConfigChange]);

  function update(field: keyof ModelConfig, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setNotice("");
    setError("");
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = validateModelConfig(form);
    if (message) {
      setError(message);
      setNotice("");
      return;
    }
    const next = { baseUrl: form.baseUrl.trim(), apiKey: form.apiKey, model: form.model.trim() };
    writeModelConfig(next);
    setForm(next);
    setSaved(next);
    onConfigChange(next);
    setError("");
    setNotice("配置已保存到当前浏览器");
  }

  function clear() {
    clearModelConfig();
    const empty = { baseUrl: "", apiKey: "", model: "" };
    setForm(empty);
    setSaved(null);
    setShowKey(false);
    onConfigChange(null);
    setError("");
    setNotice("已清除本地模型配置");
  }

  async function testConnection() {
    const message = validateModelConfig(form);
    if (message) {
      setError(message);
      setNotice("");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const startedAt = performance.now();
    try {
      const response = await fetch("/api/model/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { baseUrl: form.baseUrl.trim(), apiKey: form.apiKey, model: form.model.trim() } }),
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; latencyMs?: number; error?: string; message?: string };
      if (!response.ok || data.ok === false) throw new Error(data.message ?? data.error ?? "连接测试失败");
      setNotice(`连接成功 · ${data.latencyMs ?? Math.round(performance.now() - startedAt)} ms`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "连接测试失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  const unchanged = saved?.baseUrl === form.baseUrl && saved?.apiKey === form.apiKey && saved?.model === form.model;

  return (
    <section className="im-model-settings" aria-labelledby="model-settings-title">
      <div className="im-settings-heading">
        <div>
          <span className="im-dialog-kicker">MODEL CONNECTION</span>
          <h2 id="model-settings-title">模型配置</h2>
        </div>
        <span className={saved ? "im-config-status im-config-status-ready" : "im-config-status"}>{saved ? "已配置" : "未配置"}</span>
      </div>
      <p className="im-settings-help">支持 OpenAI-compatible 服务。配置只保存在当前浏览器，测试使用当前表单值且不会自动保存。</p>
      <form className="im-profile-form" onSubmit={save}>
        <label>Base URL<input aria-label="Base URL" type="url" value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" autoComplete="url" /></label>
        <label>API Key
          <span className="im-secret-field"><input aria-label="API Key" type={showKey ? "text" : "password"} value={form.apiKey} onChange={(event) => update("apiKey", event.target.value)} autoComplete="off" /><button type="button" onClick={() => setShowKey((current) => !current)}>{showKey ? "隐藏" : "显示"}</button></span>
        </label>
        <label>Model<input aria-label="Model" value={form.model} onChange={(event) => update("model", event.target.value)} placeholder="gpt-4o-mini" autoComplete="off" /></label>
        {error && <div className="im-auth-error" role="alert">{error}</div>}
        {notice && <div className="im-auth-message" role="status">{notice}</div>}
        <div className="im-model-actions">
          <button className="im-auth-submit" type="submit">保存配置</button>
          <button className="im-secondary-submit" type="button" onClick={() => void testConnection()} disabled={busy}>{busy ? "测试中…" : "测试连接"}</button>
          <button className="im-danger-submit" type="button" onClick={clear} disabled={!saved && unchanged}>清除配置</button>
        </div>
      </form>
    </section>
  );
}
