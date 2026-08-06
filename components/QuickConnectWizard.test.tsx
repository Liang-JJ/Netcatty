import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../application/i18n/I18nProvider";
import QuickConnectWizard from "./QuickConnectWizard";
import { PROTOCOL_VISUAL_STYLES } from "./protocolVisuals";

const source = readFileSync(new URL("./QuickConnectWizard.tsx", import.meta.url), "utf8");

test("QuickConnectWizard offers ET without obsolete Mosh path or log controls", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "example.com" }}
        keys={[]}
        identities={[]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Eternal Terminal/);
  assert.doesNotMatch(markup, /mosh --server/);
  assert.doesNotMatch(markup, /Show logs|Hide logs/);
});

test("quick connect shows saved identities as credential presets", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "192.0.2.10" }}
        keys={[]}
        identities={[{
          id: "identity-root",
          label: "Root devices",
          username: "root",
          authMethod: "password",
          password: "secret",
          created: 1,
        }]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Credential preset/);
  assert.match(markup, /Choose a saved identity/);
});

test("quick connect protocol step uses simplified connect header and protocol icons", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "10.2.0.31" }}
        keys={[]}
        identities={[]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Connect to 10\.2\.0\.31:22/);
  assert.match(markup, /lucide-plug/);
  assert.doesNotMatch(markup, />_</);
  assert.match(markup, new RegExp(PROTOCOL_VISUAL_STYLES.ssh.selected.replace("/", "\\/")));
  assert.match(markup, new RegExp(PROTOCOL_VISUAL_STYLES.mosh.idle.replace("/", "\\/")));
  assert.match(markup, new RegExp(PROTOCOL_VISUAL_STYLES.et.idle.replace("/", "\\/")));
  assert.match(markup, new RegExp(PROTOCOL_VISUAL_STYLES.telnet.idle.replace("/", "\\/")));
  assert.match(markup, /lucide-shield/);
  assert.match(markup, /lucide-radio/);
  assert.match(markup, /lucide-link-2/);
  assert.match(markup, /lucide-terminal/);
  assert.match(markup, /text-sm font-medium[^>]*>Choose protocol</);
});

test("quick connect credential section title matches protocol section title style", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "10.2.0.31" }}
        keys={[]}
        identities={[{
          id: "identity-root",
          label: "Root devices",
          username: "root",
          authMethod: "password",
          password: "secret",
          created: 1,
        }]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /text-sm font-medium[^>]*>Choose protocol</);
  assert.match(markup, /text-sm font-medium[^>]*>Credential preset</);
});

test("every quick connect completion path persists or reuses the host", () => {
  assert.match(source, /const handleConnect = \(\) =>/);
  assert.match(source, /save: true/);
  assert.match(source, /const hostToConnect = onSaveHost \? onSaveHost\(tempHost\) : tempHost/);
  assert.match(source, /case "auth":\s+handleConnect\(\);/);
  assert.match(source, /disabled=\{!canProceed\} onClick=\{handleConnect\}/);
  assert.doesNotMatch(source, /handleConnect\((?:true|false)\)/);
});

test("username credential presets use keyboard-accessible tabs and listbox navigation", () => {
  assert.match(source, /type UsernameMode = "identity" \| "custom"/);
  assert.match(source, /identities\.length > 0 \? "identity" : "custom"/);
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /role="option"/);
  assert.match(source, /event\.key === "ArrowLeft" \|\| event\.key === "ArrowUp"/);
  assert.match(source, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(source, /event\.key === "Home"/);
  assert.match(source, /event\.key === "End"/);
  assert.match(source, /step === "username" && usernameMode === "identity"/);
  assert.match(source, /\[data-identity-option="true"\]\[tabindex="0"\]/);
  assert.match(source, /\(identityOption \|\| firstFocusable\)\?\.focus\(\)/);
  assert.match(source, /button:not\(\[disabled\]\):not\(\[tabindex="-1"\]\)/);
});
