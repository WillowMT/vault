# SecretCLI UI Skill Design

## Goal

Create a global OpenCode skill that applies SecretCLI's calm, private, editorial visual language to other web applications without copying its product structure or vault-specific content.

## Scope

The skill is framework-agnostic and supports new pages, components, and visual refactors in HTML/CSS, React, Vue, and comparable web stacks. It adapts the language to dashboards, productivity tools, admin software, authentication flows, and content applications.

## Design Language

- Warm off-white work surfaces paired with deep forest navigation or framing.
- Muted mint accents, dark green primary actions, quiet gray-green text, and fine low-contrast borders.
- Humanist system typography with compact labels, editorial headings, and restrained letter spacing.
- Dense but breathable layouts, small corner radii, minimal shadows, and clear visual hierarchy.
- Simple geometric symbols rather than decorative illustration or oversized iconography.
- Reassuring, concise microcopy that communicates state without promotional language.

## Reusable Patterns

The skill covers sidebars, top bars, search, page headings, buttons, forms, tables and lists, cards, badges, toolbars, empty states, dialogs, authentication cards, media surfaces, status messages, and responsive navigation. It explains how to preserve the character when a product needs only a subset of these patterns.

## Adaptation Rules

Preserve the visual ratios and tone rather than cloning SecretCLI literally. Derive semantic color tokens, choose components based on the target workflow, and adjust information density to the application. Avoid generic gradient-heavy landing pages, excessive pills, glass effects, oversized cards, and interchangeable AI-dashboard styling.

## Quality Bar

Generated interfaces must work on desktop and mobile, include visible keyboard focus, semantic controls, reduced-motion support, safe-area handling where relevant, and readable contrast. The agent should inspect an existing design system before changing it and avoid overwriting established product conventions unless the user explicitly requests a redesign.

## Installation

Install as a model-invoked global skill at `~/.config/opencode/skills/secretcli-ui/SKILL.md`. Keep the main workflow concise and place the detailed visual reference in `references/design-language.md` for progressive disclosure.
