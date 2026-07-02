import { randomUUID } from "node:crypto"

import type { RepoRef } from "~/lib/first-mate/types"

export interface DecisionPacketInput {
  type: string
  tldr: string
  question: string
  options: Array<{
    id: string
    label: string
    consequence: string
    recommended?: boolean
  }>
  evidence?: {
    prSummary?: string
    ciExcerpt?: string
    floorVerdict?: string
    links?: Array<{ label: string; url: string }>
  }
  missionId?: string
  repo?: RepoRef
  unit?: { issue?: number | null; pr?: number | null }
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}

function safeHref(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return esc(url.href)
  } catch {
    return null
  }
}

function evidenceBody(input: DecisionPacketInput): string {
  const evidence = input.evidence
  const rows: string[] = []

  if (evidence?.prSummary !== undefined) {
    rows.push(`<dt>PR summary</dt><dd>${esc(evidence.prSummary)}</dd>`)
  }
  if (evidence?.ciExcerpt !== undefined) {
    rows.push(`<dt>CI excerpt</dt><dd><pre>${esc(evidence.ciExcerpt)}</pre></dd>`)
  }
  if (evidence?.floorVerdict !== undefined) {
    rows.push(`<dt>Floor verdict</dt><dd>${esc(evidence.floorVerdict)}</dd>`)
  }

  const links = evidence?.links ?? []
  if (links.length > 0) {
    const items = links
      .map((link) => {
        const label = esc(link.label)
        const href = safeHref(link.url)
        if (href === null) return `<li><span>${label}</span></li>`
        return `<li><a href="${href}" rel="noreferrer noopener" target="_blank">${label}</a></li>`
      })
      .join("")
    rows.push(`<dt>Links</dt><dd><ul>${items}</ul></dd>`)
  }

  if (rows.length === 0) return `<p class="muted">No evidence attached.</p>`
  return `<dl>${rows.join("")}</dl>`
}

function provenance(input: DecisionPacketInput, packetId: string, decisionId: string): string {
  const parts = [
    `<span><strong>packetId</strong> ${esc(packetId)}</span>`,
    `<span><strong>decisionId</strong> ${esc(decisionId)}</span>`,
    `<span><strong>type</strong> ${esc(input.type)}</span>`,
    `<span><strong>timestamp</strong> timestamp-placeholder</span>`,
  ]

  if (input.missionId !== undefined) {
    parts.push(`<span><strong>mission</strong> ${esc(input.missionId)}</span>`)
  }
  if (input.repo !== undefined) {
    parts.push(
      `<span><strong>repo</strong> ${esc(input.repo.owner)}/${esc(input.repo.name)}</span>`,
    )
  }
  if (input.unit !== undefined) {
    const refs: string[] = []
    if (input.unit.issue !== undefined && input.unit.issue !== null) {
      refs.push(`issue #${input.unit.issue}`)
    }
    if (input.unit.pr !== undefined && input.unit.pr !== null) {
      refs.push(`PR #${input.unit.pr}`)
    }
    if (refs.length > 0) {
      parts.push(`<span><strong>unit</strong> ${esc(refs.join(", "))}</span>`)
    }
  }

  return parts.join("\n      ")
}

export function buildDecisionPacket(input: DecisionPacketInput): {
  html: string
  packetId: string
  decisionId: string
} {
  const packetId = randomUUID()
  const decisionId = randomUUID()
  const recommendedIndex = input.options.findIndex(
    (option) => option.recommended === true,
  )
  const optionCards = input.options
    .map((option, index) => {
      const badge =
        index === recommendedIndex
          ? ` <span class="badge" aria-label="Recommended option">Recommended</span>`
          : ""
      return `<section class="option" data-option="${esc(option.id)}">
        <h2>${esc(option.label)}${badge}</h2>
        <p class="consequence">${esc(option.consequence)}</p>
      </section>`
    })
    .join("\n")

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(input.tldr)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 32px; background: #0f172a; color: #e2e8f0; }
    main { max-width: 860px; margin: 0 auto; }
    .banner { padding: 24px; border-radius: 18px; background: linear-gradient(135deg, #2563eb, #7c3aed); box-shadow: 0 18px 45px rgba(15, 23, 42, 0.35); }
    .eyebrow { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.78; }
    h1 { margin: 0; font-size: clamp(28px, 5vw, 44px); line-height: 1.05; }
    .question { margin: 24px 0; padding: 18px 20px; border: 1px solid rgba(148, 163, 184, 0.35); border-radius: 14px; background: rgba(15, 23, 42, 0.72); font-size: 18px; }
    .options { display: grid; gap: 16px; }
    .option { padding: 18px 20px; border: 1px solid rgba(148, 163, 184, 0.32); border-radius: 16px; background: rgba(30, 41, 59, 0.86); }
    .option h2 { margin: 0 0 10px; display: flex; gap: 10px; align-items: center; font-size: 20px; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; background: #22c55e; color: #052e16; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
    .consequence { margin: 0; color: #cbd5e1; }
    details { margin-top: 22px; padding: 16px 18px; border: 1px solid rgba(148, 163, 184, 0.28); border-radius: 14px; background: rgba(15, 23, 42, 0.58); }
    summary { cursor: pointer; font-weight: 700; }
    dl { display: grid; grid-template-columns: minmax(120px, 0.28fr) 1fr; gap: 10px 16px; margin: 16px 0 0; }
    dt { color: #93c5fd; font-weight: 700; }
    dd { margin: 0; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: inherit; }
    ul { margin: 0; padding-left: 18px; }
    a { color: #93c5fd; }
    .muted { margin: 14px 0 0; color: #94a3b8; }
    footer { margin-top: 22px; display: flex; flex-wrap: wrap; gap: 10px 14px; color: #94a3b8; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <header class="banner">
      <p class="eyebrow">Decision packet</p>
      <h1>${esc(input.tldr)}</h1>
    </header>
    <p class="question">${esc(input.question)}</p>
    <div class="options">
${optionCards}
    </div>
    <details>
      <summary>Evidence</summary>
      ${evidenceBody(input)}
    </details>
    <footer>
      ${provenance(input, packetId, decisionId)}
    </footer>
  </main>
</body>
</html>`

  return { html, packetId, decisionId }
}
