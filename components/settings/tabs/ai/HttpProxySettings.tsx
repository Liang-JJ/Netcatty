import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type {
  AIHttpProxyConfig,
  AIHttpProxyMode,
} from "../../../../infrastructure/ai/types";
import {
  sanitizeAIHttpProxyConfig,
} from "../../../../infrastructure/ai/types";
import { decryptField, encryptField } from "../../../../infrastructure/persistence/secureFieldAdapter";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Select, SettingCard, SettingRow, SettingsSection } from "../../settings-ui";

const DEFAULT_CUSTOM_PROXY = {
  scheme: "http" as const,
  host: "",
  port: 8080,
};

const MODE_OPTIONS: Array<{ value: AIHttpProxyMode; labelKey: string }> = [
  { value: "off", labelKey: "ai.network.mode.off" },
  { value: "system", labelKey: "ai.network.mode.system" },
  { value: "custom", labelKey: "ai.network.mode.custom" },
];

function validateProxyHost(host: string): string | null {
  const trimmed = host.trim();
  if (!trimmed) return "required";
  if (/\s/.test(trimmed) || trimmed.includes("/")) return "invalid";
  return null;
}

function validateProxyPort(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "invalid";
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return "invalid";
  return null;
}

export const HttpProxySettings: React.FC<{
  aiHttpProxyConfig: AIHttpProxyConfig;
  setAIHttpProxyConfig: (config: AIHttpProxyConfig) => void;
}> = ({ aiHttpProxyConfig, setAIHttpProxyConfig }) => {
  const { t } = useI18n();
  const config = useMemo(
    () => sanitizeAIHttpProxyConfig(aiHttpProxyConfig),
    [aiHttpProxyConfig],
  );
  const configRef = useRef(config);
  configRef.current = config;

  const custom = config.mode === "custom"
    ? { ...DEFAULT_CUSTOM_PROXY, ...config.custom }
    : DEFAULT_CUSTOM_PROXY;

  const [portInput, setPortInput] = useState(String(custom.port));
  const [passwordInput, setPasswordInput] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);

  useEffect(() => {
    setPortInput(String(custom.port));
  }, [custom.port]);

  const decryptSeqRef = useRef(0);
  useEffect(() => {
    if (!custom.password) {
      decryptSeqRef.current += 1;
      setPasswordInput("");
      setIsDecrypting(false);
      return;
    }

    const seq = ++decryptSeqRef.current;
    setIsDecrypting(true);
    decryptField(custom.password)
      .then((decrypted) => {
        if (decryptSeqRef.current === seq) {
          setPasswordInput(decrypted ?? "");
        }
      })
      .catch(() => {
        if (decryptSeqRef.current === seq) {
          setPasswordInput(custom.password ?? "");
        }
      })
      .finally(() => {
        if (decryptSeqRef.current === seq) {
          setIsDecrypting(false);
        }
      });
  }, [custom.password]);

  const updateCustomConfig = useCallback((updates: Partial<typeof DEFAULT_CUSTOM_PROXY & { username?: string; password?: string }>) => {
    const current = configRef.current;
    const nextCustom = {
      ...DEFAULT_CUSTOM_PROXY,
      ...(current.mode === "custom" ? current.custom : undefined),
      ...updates,
    };
    setAIHttpProxyConfig({
      mode: "custom",
      custom: nextCustom,
    });
  }, [setAIHttpProxyConfig]);

  const handleModeChange = useCallback((value: string) => {
    const mode = value as AIHttpProxyMode;
    if (mode === "custom") {
      const current = configRef.current.mode === "custom" ? configRef.current.custom : undefined;
      setAIHttpProxyConfig({
        mode,
        custom: {
          ...DEFAULT_CUSTOM_PROXY,
          ...current,
        },
      });
      return;
    }
    setAIHttpProxyConfig({ mode });
  }, [setAIHttpProxyConfig]);

  const blurSeqRef = useRef(0);
  const handlePasswordBlur = useCallback(async () => {
    const trimmed = passwordInput.trim();
    if (!trimmed) {
      blurSeqRef.current += 1;
      updateCustomConfig({ password: undefined });
      return;
    }

    const seq = ++blurSeqRef.current;
    const encrypted = await encryptField(trimmed);
    if (blurSeqRef.current === seq) {
      updateCustomConfig({ password: encrypted });
    }
  }, [passwordInput, updateCustomConfig]);

  const hostError = config.mode === "custom" ? validateProxyHost(custom.host) : null;
  const portError = config.mode === "custom" ? validateProxyPort(portInput) : null;

  return (
    <SettingsSection title={t("ai.network.title")}>
      <SettingCard padded className="space-y-2">
        <p className="text-sm text-muted-foreground leading-6">
          {t("ai.network.description")}
        </p>
        <p className="text-xs text-muted-foreground/80 leading-5">
          {t("ai.network.localOnly")}
        </p>
      </SettingCard>

      <SettingCard divided>
        <SettingRow
          label={t("ai.network.mode")}
          description={t("ai.network.mode.description")}
        >
          <Select
            value={config.mode}
            options={MODE_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
            onChange={handleModeChange}
            className="w-48"
          />
        </SettingRow>

        {config.mode === "custom" ? (
          <>
            <SettingRow
              label={t("ai.network.scheme")}
              description={t("ai.network.scheme.description")}
            >
              <Select
                value={custom.scheme}
                options={[
                  { value: "http", label: t("ai.network.scheme.http") },
                  { value: "https", label: t("ai.network.scheme.https") },
                ]}
                onChange={(value) => updateCustomConfig({ scheme: value === "https" ? "https" : "http" })}
                className="w-40"
              />
            </SettingRow>

            <SettingRow
              label={t("ai.network.host")}
              description={t("ai.network.host.description")}
            >
              <div className="flex flex-col items-end gap-1.5">
                <input
                  type="text"
                  value={custom.host}
                  onChange={(event) => updateCustomConfig({ host: event.target.value })}
                  placeholder={t("ai.network.host.placeholder")}
                  className="w-64 h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                {hostError ? (
                  <p className="text-xs text-destructive">
                    {hostError === "required"
                      ? t("ai.network.validation.hostRequired")
                      : t("ai.network.validation.hostInvalid")}
                  </p>
                ) : null}
              </div>
            </SettingRow>

            <SettingRow
              label={t("ai.network.port")}
              description={t("ai.network.port.description")}
            >
              <div className="flex flex-col items-end gap-1.5">
                <input
                  type="number"
                  inputMode="numeric"
                  value={portInput}
                  min={1}
                  max={65535}
                  onChange={(event) => setPortInput(event.target.value)}
                  onBlur={() => {
                    if (!portError) {
                      updateCustomConfig({ port: Number(portInput) });
                    }
                  }}
                  className="w-24 h-9 rounded-md border border-input bg-background px-3 text-sm text-right focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                {portError ? (
                  <p className="text-xs text-destructive">
                    {t("ai.network.validation.portInvalid")}
                  </p>
                ) : null}
              </div>
            </SettingRow>

            <SettingRow
              label={t("ai.network.username")}
              description={t("ai.network.username.description")}
            >
              <input
                type="text"
                value={custom.username ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  updateCustomConfig({ username: value.length > 0 ? value : undefined });
                }}
                placeholder={t("ai.network.username.placeholder")}
                className="w-56 h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </SettingRow>

            <SettingRow
              label={t("ai.network.password")}
              description={t("ai.network.password.description")}
            >
              <div className="flex items-center gap-1.5">
                <input
                  type={showPassword ? "text" : "password"}
                  value={isDecrypting ? "" : passwordInput}
                  placeholder={isDecrypting ? t("ai.providers.apiKey.decrypting") : t("ai.network.password.placeholder")}
                  onChange={(event) => setPasswordInput(event.target.value)}
                  onBlur={() => void handlePasswordBlur()}
                  className="w-56 h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  disabled={isDecrypting}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  className="p-1.5 rounded hover:bg-muted text-muted-foreground"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </SettingRow>
          </>
        ) : null}
      </SettingCard>
    </SettingsSection>
  );
};
