import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Leading-underscore parameters mark stub signatures kept for their shape (test doubles).
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      // These three are React Compiler diagnostics from eslint-plugin-react-hooks 7. This app does not
      // enable the React Compiler, and the flagged code is the established "latest value in a ref",
      // reset-before-fetch and imperative SurveyJS model patterns. They stay visible as warnings so
      // they can be reviewed case by case, but they do not fail the gate.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  {
    // These links deliberately leave the client app with a full document load: into the Clerk
    // sign-in/sign-up pages, and back to "/" after an invitation or recovery completes, so the
    // session and identity provider state are re-read from the server.
    files: ["src/app/invite/page.tsx", "src/app/recover/page.tsx", "src/components/login.tsx"],
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
  {
    // Local-only Playwright evidence harnesses that read untyped JSON responses; not part of Vitest.
    files: ["tests/**/*.browser.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "warn" },
  },
  globalIgnores([
    // Default ignores of eslint-config-next.
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Regional and CI build output, and private runtime data.
    ".next-*/**",
    "work/**",
  ]),
]);

export default eslintConfig;
