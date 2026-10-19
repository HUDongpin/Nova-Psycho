import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// Next 16 removed `next lint`. eslint-config-next is not used here because its
// @next/eslint-plugin-next -> fast-glob -> micromatch -> braces chain carries an
// unpatched high advisory (GHSA-vfj7-8cjw-p6xm). This gate is ESLint's own
// recommended correctness rules, typescript-eslint's recommended rules, and the
// React hooks plugin's recommended rules.
export default defineConfig([
  globalIgnores([
    ".next/**",
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "work/**",
  ]),
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // typescript-eslint's eslint-recommended layer switches these core correctness
      // rules off for TS files because the compiler can report them. This project's
      // tsconfig does not make all of them errors (unreachable code is only a hint by
      // default), so turn them back on. no-undef, no-redeclare and no-dupe-class-members
      // stay off: they misreport type-only names, declaration merging and overloads.
      "constructor-super": "error",
      "getter-return": "error",
      "no-const-assign": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-func-assign": "error",
      "no-import-assign": "error",
      "no-new-native-nonconstructor": "error",
      "no-obj-calls": "error",
      "no-setter-return": "error",
      "no-this-before-super": "error",
      "no-unreachable": "error",
      "no-unsafe-negation": "error",
      "no-with": "error",
    },
  },

  // Narrow, explained exceptions for code that already exists. Each lists the exact
  // files the rule currently reports in, so new code keeps the default severity.
  {
    // React Compiler diagnostic. These components keep the latest locale, draft,
    // submit callback or acknowledgement in a ref read by async handlers and event
    // listeners ("latest value" ref pattern). The app does not enable the React Compiler.
    files: [
      "src/components/documents.tsx",
      "src/components/login.tsx",
      "src/components/nova-app.tsx",
      "src/components/survey-runner.tsx",
    ],
    rules: { "react-hooks/refs": "warn" },
  },
  {
    // React Compiler diagnostic. These effects clear error/loading state before
    // starting an abortable fetch or draft load, or mirror external store state.
    files: [
      "src/app/invite/page.tsx",
      "src/app/recover/page.tsx",
      "src/components/documents.tsx",
      "src/components/nova-app.tsx",
      "src/components/survey-runner.tsx",
      "src/components/ui.tsx",
      "src/components/workspace-views.tsx",
    ],
    rules: { "react-hooks/set-state-in-effect": "warn" },
  },
  {
    // React Compiler diagnostic. The SurveyJS Model is an imperative object whose
    // mode and navigation fields are meant to be set directly.
    files: ["src/components/survey-runner.tsx"],
    rules: { "react-hooks/immutability": "warn" },
  },
  {
    // Local-only Playwright evidence harnesses (not part of Vitest) that read
    // untyped JSON API responses.
    files: [
      "tests/session-draft-recovery.browser.ts",
      "tests/waiting-refresh-lifecycle.browser.ts",
      "tests/waiting-refresh.browser.ts",
    ],
    rules: { "@typescript-eslint/no-explicit-any": "warn" },
  },
  {
    // ESLint 10 recommended rule. These rethrows deliberately replace the caught error:
    // report-queue keeps job failure details out of the queue platform's error, and the
    // backup helpers already copy the underlying message into a clearer operator message.
    files: ["scripts/backup-lib.ts", "src/lib/report-queue.ts"],
    rules: { "preserve-caught-error": "warn" },
  },
  {
    // ESLint 10 recommended rule. probeClass keeps "not_run" as a readable default
    // before the try block that always overwrites it.
    files: ["scripts/ai-conformance.ts"],
    rules: { "no-useless-assignment": "warn" },
  },
  {
    // Test doubles keep the real signature; leading-underscore parameters are unused on purpose.
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
]);
