import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentCard, hash, isEmptyPatch, planSeed } from '../deploy/soul-seed.mjs';

const patch = card => JSON.stringify([{insert: [{id: 'soul-md', name: 'dsh-soul-md', config: {
  cards: {'大肥鱼': card}, active: '大肥鱼', complete: true, memory: {inject: false, recall: 'off'},
}}]}], null, 2);

test('the seeded patch round-trips to the card it holds', () => {
  assert.equal(currentCard(patch('你是大肥鱼。')), '你是大肥鱼。');
  // Anything this module did not write must not be edited as if it had.
  assert.equal(currentCard('insert:\n  - id: soul-md\n'), undefined);
  assert.equal(currentCard('[]'), undefined);
  assert.equal(currentCard(JSON.stringify([{insert: [{id: 'other', config: {cards: {a: 'x'}, active: 'a'}}]}])), undefined);
});

test('a first start writes the card and a start on an identical card does not', () => {
  assert.deepEqual(planSeed({soul: 'A', patch: false, recorded: undefined}), {action: 'write'});
  assert.deepEqual(planSeed({soul: 'A', patch: true, card: 'A', recorded: undefined}), {action: 'record'});
  assert.deepEqual(planSeed({soul: 'A', patch: true, card: 'A', recorded: hash('A')}), {action: 'none'});
});

test('a changed image soul replaces only the card that was seeded', () => {
  // Seeded A, image now B, profile still holds the seeded A.
  assert.deepEqual(planSeed({soul: 'B', card: 'A', recorded: hash('A')}), {action: 'write'});
});

test('a card edited in Web survives an image with a different soul', () => {
  // Seeded A, someone wrote C in Web, image carries B.
  assert.deepEqual(planSeed({soul: 'B', card: 'C', recorded: hash('A')}), {action: 'conflict', reason: 'edited'});
  assert.deepEqual(planSeed({soul: 'B', card: 'C', recorded: hash('A'), force: true}), {action: 'write'});
});

test('volumes seeded before hashes were recorded need a person to choose', () => {
  // The profile holds A, the image holds B, and nothing says who wrote A.
  const first = planSeed({soul: 'B', card: 'A', recorded: undefined});
  assert.deepEqual(first, {action: 'conflict', reason: 'unrecorded'});
  assert.deepEqual(planSeed({soul: 'B', card: 'A', recorded: undefined, force: true}), {action: 'write'});
  // The conflict must repeat on the next start, or the card would be replaced unasked.
  assert.deepEqual(planSeed({soul: 'B', card: 'A', recorded: undefined}), first);
});

test('a patch that is not ours is only replaced when asked', () => {
  assert.deepEqual(planSeed({soul: 'B', patch: true, card: undefined, recorded: hash('A')}),
    {action: 'conflict', reason: 'unreadable'});
  assert.deepEqual(planSeed({soul: 'B', patch: true, card: undefined, recorded: hash('A'), force: true}),
    {action: 'write'});
});

test('a fresh volume whose template is empty is seeded rather than treated as a conflict', () => {
  // DSH's initProfile writes a comment header followed by `[]`; that cannot JSON.parse,
  // so before isEmptyPatch existed every first start logged "unreadable" and kept the
  // default coding persona instead of the Soul card.
  const template = '# Your patch layer for this dsh profile\n# a top-level YAML array\n[]\n';
  assert.equal(currentCard(template), undefined);
  assert.equal(isEmptyPatch(template), true);
  assert.equal(isEmptyPatch('[]'), true);
  assert.equal(isEmptyPatch('   \n\n'), true);
  assert.deepEqual(planSeed({soul: 'A', card: currentCard(template), patch: true,
    empty: isEmptyPatch(template), recorded: undefined}), {action: 'write'});
  // A patch holding an entry this module cannot read is still someone else's.
  assert.equal(isEmptyPatch('insert:\n  - id: soul-md\n'), false);
  assert.deepEqual(planSeed({soul: 'A', card: undefined, patch: true, empty: false,
    recorded: undefined}), {action: 'conflict', reason: 'unreadable'});
  // The seeded patch is never "empty", so a later start still compares cards.
  assert.equal(isEmptyPatch(patch('A')), false);
});
