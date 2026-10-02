import { describe, expect, it } from 'vitest'

import { createComposerFuzzyScorer } from './composerFuzzySearch'

describe('createComposerFuzzyScorer', () => {
  it('rejects arbitrary character subsequences that the reference matcher does not accept', () => {
    const score = createComposerFuzzyScorer('readme')

    expect(score('spreadsheets@presentation-skill')).toBe(0)
    expect(score('openai-templates:artifact-template-simple-dark-mode')).toBe(0)
    expect(score('Prometheus Strict requirements interviewer and ambiguity mapper')).toBe(0)
    expect(
      score(
        'Ontology-first reasoning reviewer: category mistakes, hidden assumptions, modality separation, scholastic critique, and minimal-repair proposals'
      )
    ).toBe(0)
  })

  it('keeps contiguous, word-boundary, camel-case, and path-aware matches', () => {
    expect(createComposerFuzzyScorer('readme')('README.md')).toBeGreaterThan(0)
    expect(createComposerFuzzyScorer('cs')('composer search')).toBeGreaterThan(0)
    expect(createComposerFuzzyScorer('cS')('composerSearch')).toBeGreaterThan(0)
    expect(createComposerFuzzyScorer('src/read')('/repo/src/README.md')).toBeGreaterThan(0)
  })
})
