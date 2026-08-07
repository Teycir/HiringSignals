// Shared ESLint flat-config building blocks for every workspace package.
// Each app/package composes these with its own framework-specific config
// on top (CLI apps add no framework layer; Worker API uses hono-aware rules
// inline if needed).
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
      "**/dist/**",
      "**/.wrangler/**",
      "**/coverage/**",
    ],
  },
];

export default baseConfig;
