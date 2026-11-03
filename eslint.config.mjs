import antfu from "@antfu/eslint-config";

export default antfu({
  type: "app",
  typescript: true,
  formatters: true,
  stylistic: {
    indent: 2,
    semi: true,
    quotes: "double",
  },
  // Prose and tool configuration, not source. `formatters: true` runs
  // prettier over markdown, which would repad every table in the planning
  // documents; `.claude/` and `.mcp.json` belong to the editor tooling.
  ignores: ["**/migrations/*", "**/*.md", ".claude/**", ".mcp.json"],
}, {
  rules: {
    "no-console": ["warn"],
    "antfu/no-top-level-await": ["off"],
    "node/prefer-global/process": ["off"],
    "node/no-process-env": ["error"],
    "perfectionist/sort-imports": ["error", {
      tsconfigRootDir: ".",
    }],
    "unicorn/filename-case": ["error", {
      case: "kebabCase",
      ignore: ["README.md", "CLAUDE.md", "SPEC.md", "SCHEMA.md", "ROADMAP.md", "PRIVATE-NOTES.md", "LICENSE"],
    }],
  },
});
