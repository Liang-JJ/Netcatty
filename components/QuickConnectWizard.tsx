import {
  ArrowLeft,
  Eye,
  EyeOff,
  Globe,
  Key,
  Lock,
  Plus,
  Terminal as TerminalIcon,
  User,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import type { QuickConnectTarget } from "../domain/quickConnect";
import { formatHostPort } from "../domain/host";
import { cn } from "../lib/utils";
import { Host, Identity, SSHKey } from "../types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ScrollArea } from "./ui/scroll-area";

// Protocol types supported for quick connect
type Protocol = "ssh" | "mosh" | "telnet";

// Wizard steps
type WizardStep = "protocol" | "username" | "knownhost" | "auth";

interface QuickConnectWizardProps {
  open: boolean;
  target: QuickConnectTarget;
  keys: SSHKey[];
  identities?: Identity[];
  warnings?: string[];
  onConnect: (host: Host) => void;
  onSaveHost?: (host: Host) => void;
  onAddKey?: () => void;
  onClose: () => void;
}

const QuickConnectWizard: React.FC<QuickConnectWizardProps> = ({
  open,
  target,
  keys,
  identities = [],
  warnings,
  onConnect,
  onSaveHost,
  onAddKey,
  onClose,
}) => {
  const { t } = useI18n();
  // Wizard state
  const [step, setStep] = useState<WizardStep>("protocol");
  const [protocol, setProtocol] = useState<Protocol>("ssh");
  const [username, setUsername] = useState(target.username || "");
  const [port, setPort] = useState<number>(target.port || 22);
  const [moshServerPath, setMoshServerPath] = useState("");
  const [showLogs, setShowLogs] = useState(false);

  // Known host verification state
  const [knownHostInfo, setKnownHostInfo] = useState<{
    keyType: string;
    fingerprint: string;
  } | null>(null);

  // Auth state
  const [authMethod, setAuthMethod] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [saveCredentials] = useState(true);

  // Keychain tab state (used in username step)
  const [credentialSourceTab, setCredentialSourceTab] = useState<"manual" | "keychain">("keychain");
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null);
  const identitySelectRef = useRef<HTMLSelectElement>(null);

  // Reset state when target changes
  React.useEffect(() => {
    if (open) {
      setStep("protocol");
      setProtocol("ssh");
      setUsername(target.username || "");
      setPort(target.port || 22);
      setPassword("");
      setSelectedKeyId(null);
      setSelectedIdentityId(null);
      setShowPassword(false);
      setKnownHostInfo(null);
      setCredentialSourceTab("keychain");
    }
  }, [open, target]);

  // Refs for auto-focus and keyboard navigation
  const wizardContentRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const sshBtnRef = useRef<HTMLButtonElement>(null);
  const moshBtnRef = useRef<HTMLButtonElement>(null);
  const telnetBtnRef = useRef<HTMLButtonElement>(null);

  // Auto-focus first focusable element when wizard opens or step changes
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      // In username step with keychain tab, focus the identity select directly
      if (step === "username" && credentialSourceTab === "keychain" && identitySelectRef.current) {
        identitySelectRef.current.focus();
        return;
      }
      if (wizardContentRef.current) {
        const firstFocusable = wizardContentRef.current.querySelector<HTMLElement>(
          'input:not([type="hidden"]), button:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
        );
        firstFocusable?.focus();
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [open, step, credentialSourceTab]);

  // Focus trap + global Enter: keep Tab cycling within the modal, Enter = next step
  const handleModalKeyDown = (e: React.KeyboardEvent) => {
    // Global Enter: go to next step (unless focused on back/close button)
    if (e.key === "Enter") {
      const active = document.activeElement;
      // Don't trigger if focused on the back/close button (let that button handle its own click)
      const isBackButton = active instanceof HTMLElement &&
        (active.getAttribute("data-action") === "back" || active.getAttribute("data-action") === "close");
      if (!isBackButton && canProceed) {
        e.preventDefault();
        handleContinue();
      }
      return;
    }

    if (e.key !== "Tab") return;
    if (!modalRef.current) return;

    const focusable = modalRef.current.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  // Protocol order for arrow key navigation
  const PROTOCOLS: Protocol[] = ["ssh", "mosh", "telnet"];
  const protocolBtnRefs: Record<Protocol, React.RefObject<HTMLButtonElement>> = {
    ssh: sshBtnRef,
    mosh: moshBtnRef,
    telnet: telnetBtnRef,
  };

  const getNextProtocol = (current: Protocol, direction: "up" | "down"): Protocol => {
    const idx = PROTOCOLS.indexOf(current);
    if (direction === "down") {
      return PROTOCOLS[(idx + 1) % PROTOCOLS.length];
    }
    return PROTOCOLS[(idx - 1 + PROTOCOLS.length) % PROTOCOLS.length];
  };

  // Get default port for protocol
  const getDefaultPort = (proto: Protocol) => {
    switch (proto) {
      case "ssh":
        return 22;
      case "mosh":
        return 22;
      case "telnet":
        return 23;
      default:
        return 22;
    }
  };

  // Handle protocol selection
  const handleProtocolSelect = (proto: Protocol) => {
    setProtocol(proto);
    if (port === getDefaultPort(protocol)) {
      setPort(getDefaultPort(proto));
    }
  };

  // Navigate to next step
  const handleContinue = () => {
    switch (step) {
      case "protocol":
        setStep("username");
        break;
      case "username":
        // If using keychain tab with a selected credential, skip auth step
        if (credentialSourceTab === "keychain" && canSkipAuth()) {
          handleConnect();
        } else {
          setStep("auth");
        }
        break;
      case "knownhost":
        setStep("auth");
        break;
      case "auth":
        handleConnect();
        break;
    }
  };

  // Check if we have enough from keychain to skip the auth step
  const canSkipAuth = () => {
    return !!selectedIdentityId; // Identity has all needed info
  };

  // Navigate back
  const handleBack = () => {
    switch (step) {
      case "username":
        setStep("protocol");
        break;
      case "knownhost":
        setStep("username");
        break;
      case "auth":
        setStep("username");
        break;
    }
  };

  // Create host and connect
  const handleConnect = () => {
    const effectivePort = port || getDefaultPort(protocol);
    let effectiveUsername = username || target.username || "root";
    let effectivePassword = password;
    let effectiveAuthMethod = authMethod;
    let effectiveKeyId = selectedKeyId;

    // If using keychain tab, resolve credentials from selected identity
    if (credentialSourceTab === "keychain" && selectedIdentityId) {
      const selectedIdent = identities.find((i) => i.id === selectedIdentityId);
      if (selectedIdent) {
        effectiveUsername = selectedIdent.username || effectiveUsername;
        effectivePassword = selectedIdent.password || "";
        effectiveAuthMethod = selectedIdent.authMethod === "certificate" ? "certificate" : "password";
        if (selectedIdent.keyId) {
          effectiveKeyId = selectedIdent.keyId;
          effectiveAuthMethod = selectedIdent.authMethod === "certificate" ? "certificate" : "key";
        }
      }
    }

    const tempHost: Host = {
      id: `quick-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      label: `${target.hostname}`,
      hostname: target.hostname,
      port: effectivePort,
      username: effectiveUsername,
      group: "",
      tags: [],
      os: "linux",
      protocol: protocol === "mosh" ? "ssh" : protocol,
      authMethod: effectiveAuthMethod,
      password: effectiveAuthMethod === "password" ? effectivePassword : undefined,
      identityFileId:
        effectiveAuthMethod === "key" || effectiveAuthMethod === "certificate" ? effectiveKeyId || undefined : undefined,
      moshEnabled: protocol === "mosh",
      telnetEnabled: protocol === "telnet",
      telnetPort: protocol === "telnet" ? effectivePort : undefined,
      createdAt: Date.now(),
    };

    if (saveCredentials && onSaveHost) {
      onSaveHost(tempHost);
    }

    onConnect(tempHost);
    onClose();
  };

  // Check if can proceed
  const canProceed = useMemo(() => {
    switch (step) {
      case "protocol":
        return true;
      case "username":
        if (credentialSourceTab === "keychain") {
          return !!selectedIdentityId;
        }
        return username.trim().length > 0;
      case "knownhost":
        return true;
      case "auth":
        if (authMethod === "password") {
          return password.trim().length > 0;
        }
        return !!selectedKeyId;
    }
  }, [step, username, authMethod, password, selectedKeyId, credentialSourceTab, selectedIdentityId]);

  // ============== Render: Credential Source Tabs (shared by username and auth steps) ==============
  const renderCredentialSourceTabs = () => (
    <div
      className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60"
      role="tablist"
      aria-label={t("quickConnect.credentialSource")}
    >
      <button
        role="tab"
        aria-selected={credentialSourceTab === "manual"}
        className={cn(
          "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all outline-none",
          credentialSourceTab === "manual"
            ? "bg-primary text-primary-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary/30",
        )}
        onClick={() => setCredentialSourceTab("manual")}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            setCredentialSourceTab("keychain");
          }
        }}
      >
        <Lock size={14} />
        {t("quickConnect.manualInput")}
      </button>
      <button
        role="tab"
        aria-selected={credentialSourceTab === "keychain"}
        className={cn(
          "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all outline-none",
          credentialSourceTab === "keychain"
            ? "bg-primary text-primary-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary/30",
        )}
        onClick={() => setCredentialSourceTab("keychain")}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            setCredentialSourceTab("manual");
          }
        }}
      >
        <Key size={14} />
        {t("quickConnect.fromKeychain")}
      </button>
    </div>
  );

  // ============== Render: Keychain Selection UI (Identity only) ==============
  const renderKeychainSelection = () => {
    const identityOptions = identities
      .map((ident) => ({
        value: ident.id,
        label: ident.label,
        sublabel: ident.username,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

    const selectedIdentity = identities.find((i) => i.id === selectedIdentityId);

    const selectIdentity = (id: string | null) => {
      setSelectedIdentityId(id);
      if (id) {
        const ident = identities.find((i) => i.id === id);
        if (ident) {
          setUsername(ident.username || username);
          if (ident.password) setPassword(ident.password);
          if (ident.authMethod) {
            setAuthMethod(ident.authMethod === "certificate" ? "key" : ident.authMethod);
          }
          if (ident.keyId) {
            setSelectedKeyId(ident.keyId);
          }
        }
      }
    };

    // Handle ArrowUp/ArrowDown to directly change value without opening dropdown
    const handleIdentityKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const opts = identityOptions;
        if (opts.length === 0) return;
        const currentIdx = opts.findIndex((o) => o.value === (selectedIdentityId || ""));
        const nextIdx = e.key === "ArrowDown"
          ? Math.min(currentIdx + 1, opts.length - 1)
          : Math.max(currentIdx - 1, 0);
        if (nextIdx >= 0 && nextIdx < opts.length && nextIdx !== currentIdx) {
          selectIdentity(opts[nextIdx].value);
        }
      }
    };

    return (
      <div className="space-y-3">
        <div className="space-y-2">
          <Label>{t("quickConnect.selectCredential")}</Label>
          <div
            className="rounded-lg border-2 border-border/60 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30 transition-all"
            onKeyDown={handleIdentityKeyDown}
          >
            {identityOptions.length === 0 ? (
              <div className="text-sm text-muted-foreground p-3 text-center">
                {t("quickConnect.noIdentities")}
              </div>
            ) : (
              <select
                ref={identitySelectRef}
                className="w-full bg-transparent px-3 py-2.5 text-sm rounded-lg outline-none cursor-pointer"
                value={selectedIdentityId || ""}
                onChange={(e) => selectIdentity(e.target.value || null)}
                onKeyDown={(e) => {
                  // Prevent select from opening dropdown on arrow keys
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                  }
                }}
              >
                <option value="">{t("quickConnect.selectIdentity")}</option>
                {identityOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label} ({opt.sublabel})
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Show selected credential summary */}
        {selectedIdentityId && selectedIdentity && (
          <div className="text-xs text-muted-foreground p-2 bg-secondary/50 rounded-lg">
            {t("quickConnect.willLoginAs", {
              username: selectedIdentity.username,
              method: selectedIdentity.authMethod === "password"
                ? t("terminal.auth.password")
                : t("terminal.auth.sshKey"),
            })}
          </div>
        )}
      </div>
    );
  };

  // ============== Render Steps ==============

  // Render protocol selection step
  const renderProtocolStep = () => (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">{t("protocolSelect.chooseProtocol")}</h3>
      <div className="space-y-3">
        {/* SSH */}
        <button
          ref={sshBtnRef}
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left outline-none",
            protocol === "ssh"
              ? "border-primary bg-primary/5 ring-2 ring-primary/30"
              : "border-border/60 hover:border-border hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-primary/30",
          )}
          onClick={() => handleProtocolSelect("ssh")}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              const next = getNextProtocol("ssh", "down");
              handleProtocolSelect(next);
              protocolBtnRefs[next].current?.focus();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              const prev = getNextProtocol("ssh", "up");
              handleProtocolSelect(prev);
              protocolBtnRefs[prev].current?.focus();
            } else if (e.key === "Enter") {
              e.preventDefault();
              handleContinue();
            }
          }}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "ssh"
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <TerminalIcon size={18} />
            </div>
            <div>
              <div className="font-medium">SSH</div>
              <div className="text-xs text-muted-foreground font-mono">
                ssh {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "ssh" ? port : 22}
              onChange={(e) => {
                setPort(parseInt(e.target.value) || 22);
                setProtocol("ssh");
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>

        {/* Mosh */}
        <button
          ref={moshBtnRef}
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left outline-none",
            protocol === "mosh"
              ? "border-primary bg-primary/5 ring-2 ring-primary/30"
              : "border-border/60 hover:border-border hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-primary/30",
          )}
          onClick={() => handleProtocolSelect("mosh")}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              const next = getNextProtocol("mosh", "down");
              handleProtocolSelect(next);
              protocolBtnRefs[next].current?.focus();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              const prev = getNextProtocol("mosh", "up");
              handleProtocolSelect(prev);
              protocolBtnRefs[prev].current?.focus();
            } else if (e.key === "Enter") {
              e.preventDefault();
              handleContinue();
            }
          }}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "mosh"
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <Globe size={18} />
            </div>
            <div>
              <div className="font-medium">Mosh</div>
              <div className="text-xs text-muted-foreground font-mono">
                mosh {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "mosh" ? port : 22}
              onChange={(e) => {
                setPort(parseInt(e.target.value) || 22);
                setProtocol("mosh");
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
            <Input
              type="text"
              value={moshServerPath}
              onChange={(e) => setMoshServerPath(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="mosh --server=/path/server host"
              className="w-40 h-7 text-xs"
            />
          </div>
        </button>

        {/* Telnet */}
        <button
          ref={telnetBtnRef}
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left outline-none",
            protocol === "telnet"
              ? "border-primary bg-primary/5 ring-2 ring-primary/30"
              : "border-border/60 hover:border-border hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-primary/30",
          )}
          onClick={() => handleProtocolSelect("telnet")}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              const next = getNextProtocol("telnet", "down");
              handleProtocolSelect(next);
              protocolBtnRefs[next].current?.focus();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              const prev = getNextProtocol("telnet", "up");
              handleProtocolSelect(prev);
              protocolBtnRefs[prev].current?.focus();
            } else if (e.key === "Enter") {
              e.preventDefault();
              handleContinue();
            }
          }}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "telnet"
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <TerminalIcon size={18} />
            </div>
            <div>
              <div className="font-medium">Telnet</div>
              <div className="text-xs text-muted-foreground font-mono">
                telnet {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "telnet" ? port : 23}
              onChange={(e) => {
                setPort(parseInt(e.target.value) || 23);
                setProtocol("telnet");
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>
      </div>
    </div>
  );

  // Render username step (with tabs: manual input / from keychain)
  const renderUsernameStep = () => (
    <div className="space-y-4">
      {renderCredentialSourceTabs()}

      {credentialSourceTab === "manual" ? (
        /* Manual input: username field */
        <div className="space-y-2">
          <Label htmlFor="quick-username">{t("terminal.auth.username")}</Label>
          <Input
            id="quick-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("terminal.auth.username.placeholder")}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && username.trim()) {
                handleContinue();
              }
            }}
          />
        </div>
      ) : (
        /* Keychain selection: type + credential dropdowns */
        renderKeychainSelection()
      )}
    </div>
  );

  // Render known host verification step
  const renderKnownHostStep = () => (
    <div
      className="space-y-4"
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleContinue();
        }
      }}
    >
      <h3 className="text-base font-semibold text-amber-600 dark:text-amber-500">
        {t("quickConnect.knownHost.title")}
      </h3>
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>{t("quickConnect.knownHost.authenticity", { hostname: target.hostname })}</p>
        {knownHostInfo && (
          <>
            <p className="font-medium text-foreground">
              {t("quickConnect.knownHost.fingerprintLabel", { keyType: knownHostInfo.keyType })}
            </p>
            <p className="font-mono text-xs bg-muted p-2 rounded break-all">
              {knownHostInfo.fingerprint}
            </p>
          </>
        )}
        <p>{t("quickConnect.knownHost.addQuestion")}</p>
      </div>
    </div>
  );

  // Render auth step (simplified: manual password/key input only, no tabs)
  const renderAuthStep = () => (
    <div className="space-y-4">
      {/* Auth method tabs - only used when coming from manual username */}
      <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60">
        <button
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all outline-none",
            authMethod === "password"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary/30",
          )}
          onClick={() => setAuthMethod("password")}
        >
          <Lock size={14} />
          {t("terminal.auth.password")}
        </button>
        <button
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all outline-none",
            authMethod === "key"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary/30",
          )}
          onClick={() => setAuthMethod("key")}
        >
          <Key size={14} />
          {t("terminal.auth.sshKey")}
        </button>
      </div>

      {/* Password field */}
      {authMethod === "password" && (
        <div className="space-y-2">
          <Label htmlFor="quick-password">{t("terminal.auth.passwordLabel")}</Label>
          <div className="relative">
            <Input
              id="quick-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("terminal.auth.password.placeholder")}
              className="pr-10"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && password.trim()) {
                  handleConnect();
                }
              }}
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
      )}

      {/* Key selection */}
      {authMethod === "key" && (
        <div className="space-y-2">
          {keys.filter((k) => k.category === "key").length === 0 ? (
            <div className="text-sm text-muted-foreground p-3 border border-dashed border-border/60 rounded-lg text-center">
              {t("terminal.auth.noKeysHint")}
            </div>
          ) : (
            <ScrollArea className="max-h-48">
              <div className="space-y-2">
                {keys
                  .filter((k) => k.category === "key")
                  .map((key) => (
                    <button
                      key={key.id}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors text-left outline-none",
                        selectedKeyId === key.id
                          ? "border-primary bg-primary/5 ring-2 ring-primary/30"
                          : "border-border/50 hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-primary/30",
                      )}
                      onClick={() => setSelectedKeyId(key.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          setSelectedKeyId(key.id);
                        }
                      }}
                    >
                      <div
                        className={cn(
                          "h-8 w-8 rounded-lg flex items-center justify-center",
                          "bg-primary/20 text-primary",
                        )}
                      >
                        <Key size={14} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {key.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Type {key.type}
                        </div>
                      </div>
                    </button>
                  ))}
              </div>
            </ScrollArea>
          )}

          {onAddKey && (
            <Button
              variant="outline"
              size="sm"
              className="w-full mt-2"
              onClick={onAddKey}
            >
              <Plus size={14} className="mr-2" />
              Add key
            </Button>
          )}
        </div>
      )}
    </div>
  );

  // Get step title
  const getStepTitle = () => target.hostname;

  // Get step subtitle
  const getStepSubtitle = () => {
    const effectiveUsername = username || target.username || "";
    switch (step) {
      case "protocol":
        return target.hostname;
      case "username":
        return `${protocol.toUpperCase()} ${formatHostPort(target.hostname, port)}`;
      case "knownhost":
        return `${protocol.toUpperCase()} ${effectiveUsername}@${formatHostPort(target.hostname, port)}`;
      case "auth":
        return `${protocol.toUpperCase()} ${formatHostPort(target.hostname, port)}`;
    }
  };

  // Render progress indicator
  const renderProgressIndicator = () => {
    const steps: WizardStep[] = target.username
      ? ["protocol", "auth"]
      : ["protocol", "username", "auth"];
    const currentIndex = steps.indexOf(step);

    return (
      <div className="flex items-center gap-3 py-3">
        <div
          className={cn(
            "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
            currentIndex >= 0
              ? "bg-primary/20 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          <TerminalIcon size={14} />
        </div>
        <div className="flex-1 h-0.5 bg-muted" />
        {!target.username && (
          <>
            <div
              className={cn(
                "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
                currentIndex >= 1
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <User size={14} />
            </div>
            <div className="flex-1 h-0.5 bg-muted" />
          </>
        )}
        <div
          className={cn(
            "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
            step === "auth"
              ? "bg-primary/20 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {authMethod === "password" ? <Lock size={14} /> : <Key size={14} />}
        </div>
        <div className="flex-1 h-0.5 bg-muted" />
        <div className="h-8 w-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-mono">
          {">_"}
        </div>
      </div>
    );
  };

  // Determine the "next" button text for the username step
  const getContinueButtonText = () => {
    if (step === "auth") return t("terminal.auth.continueSave");
    if (step === "username" && credentialSourceTab === "keychain" && canSkipAuth()) {
      return t("common.continue");
    }
    return t("common.continue");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        className="w-[560px] max-w-[90vw] bg-background border border-border rounded-2xl animate-in fade-in-0 zoom-in-95 duration-200 outline-none"
        style={{
          boxShadow:
            "0 25px 50px -12px rgba(0, 0, 0, 0.25), 0 12px 24px -8px rgba(0, 0, 0, 0.15)",
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleModalKeyDown}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-xl bg-primary/15 text-primary flex items-center justify-center">
                <TerminalIcon size={22} />
              </div>
              <div>
                <h2 className="text-base font-semibold">{getStepTitle()}</h2>
                <p className="text-xs text-muted-foreground font-mono">
                  {getStepSubtitle()}
                </p>
              </div>
            </div>
            {(step === "auth" || (step === "knownhost" && !knownHostInfo)) && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => setShowLogs(!showLogs)}
              >
                {showLogs ? "Hide logs" : "Show logs"}
              </Button>
            )}
          </div>
        </div>

        {/* Progress indicator */}
        <div className="px-6">{renderProgressIndicator()}</div>

        {warnings && warnings.length > 0 && (
          <div className="px-6 pb-2">
            <div className="text-xs text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              {t("quickConnect.warning.unparsedOptions", {
                options: warnings.join(", "),
              })}
            </div>
          </div>
        )}

        {/* Content */}
        <div ref={wizardContentRef} className="px-6 py-4">
          {step === "protocol" && renderProtocolStep()}
          {step === "username" && renderUsernameStep()}
          {step === "knownhost" && renderKnownHostStep()}
          {step === "auth" && renderAuthStep()}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border/50 flex items-center justify-between">
          <Button
            variant="secondary"
            data-action={step === "protocol" ? "close" : "back"}
            onClick={step === "protocol" ? onClose : handleBack}
          >
            {step === "protocol" ? (
              t("common.close")
            ) : (
              <>
                <ArrowLeft size={14} className="mr-2" />
                {t("common.back")}
              </>
            )}
          </Button>

          {step === "knownhost" ? (
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={handleContinue}>
                {t("common.continue")}
              </Button>
              <Button
                onClick={() => {
                  handleContinue();
                }}
              >
                {t("quickConnect.knownHost.addAndContinue")}
              </Button>
            </div>
          ) : (
            <Button onClick={handleContinue} disabled={!canProceed}>
              {getContinueButtonText()}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default QuickConnectWizard;
