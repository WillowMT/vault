# SecretCLI UI Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a global OpenCode skill that adapts SecretCLI's visual language to other web applications.

**Architecture:** Keep invocation and workflow guidance in `SKILL.md`. Put detailed tokens, composition rules, component recipes, responsive behavior, accessibility requirements, and anti-patterns in one disclosed reference file.

**Tech Stack:** OpenCode skills, Markdown, CSS design-system vocabulary

## Global Constraints

- Install globally at `~/.config/opencode/skills/secretcli-ui/`.
- Support HTML/CSS, React, Vue, and comparable web stacks without requiring a dependency.
- Adapt the design language to the target product instead of copying vault-specific content.
- Preserve existing product conventions unless the user explicitly requests a redesign.

---

### Task 1: Create and Validate the Global Skill

**Files:**
- Create: `~/.config/opencode/skills/secretcli-ui/SKILL.md`
- Create: `~/.config/opencode/skills/secretcli-ui/references/design-language.md`

**Interfaces:**
- Consumes: A web UI creation or redesign request and the target project's existing frontend conventions.
- Produces: Framework-appropriate UI code using the SecretCLI-derived design language.

- [ ] **Step 1: Create the skill workflow**

Write valid YAML frontmatter with the name `secretcli-ui` and a model-facing description that triggers for requests to reproduce SecretCLI's UI, create calm privacy-oriented interfaces, or apply its forest-and-paper visual language. Direct the agent to inspect the target project, choose only relevant patterns, implement responsive and accessible code, and verify the result.

- [ ] **Step 2: Create the visual reference**

Document exact semantic color tokens, typography, spacing, radii, borders, shadows, layout ratios, component recipes, responsive breakpoints, interaction states, microcopy tone, accessibility rules, adaptation examples, and visual anti-patterns derived from SecretCLI.

- [ ] **Step 3: Validate the skill**

Run:

```bash
python /Users/waiyan/.claude/skills/skill-creator/scripts/quick_validate.py /Users/waiyan/.config/opencode/skills/secretcli-ui
```

Expected: validation succeeds with no frontmatter or structure errors.

- [ ] **Step 4: Review completeness**

Confirm the skill covers dashboard, authentication, content, and admin layouts; supports desktop and mobile; preserves accessibility; and contains no SecretCLI-specific product assumptions.

- [ ] **Step 5: Activate the skill**

Quit and restart OpenCode so the new global skill is discovered.
