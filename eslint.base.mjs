// Shared ESLint flat-config building blocks for every workspace package.
// Each app/package composes these with its own framework-specific config
// (e.g. apps/web adds next/core-web-vitals on top of this).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** @type {import("eslint").Linter.Config[]} */
export const baseConfig = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/out/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/coverage/**",
    ],
  },
];

export default baseConfig;
