import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_SLOTS,
  diffTemplateSlots,
  extractSlots,
  renderSlots,
  renderTemplate,
  templateSlots,
  TEMPLATES,
} from '../src/proposals/templates';

/**
 * The template editor and the write routes both refuse a template whose body and
 * declared variable list disagree, in either direction: a slot with no
 * declaration never gets a value at draft time, and a declaration with no slot
 * silently does nothing.
 */
describe('diffTemplateSlots', () => {
  it('accepts a body whose slots are exactly the declared variables', () => {
    const diff = diffTemplateSlots('{{focus}} then {{planStep1}}', ['focus', 'planStep1']);

    expect(diff.used).toEqual(['focus', 'planStep1']);
    expect(diff.declared).toEqual(['focus', 'planStep1']);
    expect(diff.undeclared).toEqual([]);
    expect(diff.unused).toEqual([]);
  });

  it('does not care about declaration order', () => {
    const diff = diffTemplateSlots('{{focus}} then {{planStep1}}', ['planStep1', 'focus']);
    expect(diff.undeclared).toEqual([]);
    expect(diff.unused).toEqual([]);
  });

  it('names a slot used in the body but never declared', () => {
    const diff = diffTemplateSlots('{{focus}} and {{proofPoint}}', ['focus']);

    expect(diff.undeclared).toEqual(['proofPoint']);
    expect(diff.unused).toEqual([]);
  });

  it('names a variable declared but absent from the body', () => {
    const diff = diffTemplateSlots('{{focus}} only', ['focus', 'priceLine']);

    expect(diff.undeclared).toEqual([]);
    expect(diff.unused).toEqual(['priceLine']);
  });

  it('reports both directions at once', () => {
    const diff = diffTemplateSlots('{{focus}} and {{availability}}', ['focus', 'priceLine']);

    expect(diff.undeclared).toEqual(['availability']);
    expect(diff.unused).toEqual(['priceLine']);
  });

  it('counts a repeated slot once, in first-appearance order', () => {
    const diff = diffTemplateSlots('{{b}} {{a}} {{b}}', ['a', 'b', 'b']);

    expect(diff.used).toEqual(['b', 'a']);
    expect(diff.declared).toEqual(['a', 'b']);
    expect(diff.undeclared).toEqual([]);
    expect(diff.unused).toEqual([]);
  });

  it('ignores blank declarations and surrounding whitespace', () => {
    const diff = diffTemplateSlots('{{ focus }}', [' focus ', '', '   ']);

    expect(diff.used).toEqual(['focus']);
    expect(diff.declared).toEqual(['focus']);
    expect(diff.undeclared).toEqual([]);
    expect(diff.unused).toEqual([]);
  });

  it('treats a body with no slots and no declarations as valid', () => {
    const diff = diffTemplateSlots('A letter with no slots at all.', []);

    expect(diff.used).toEqual([]);
    expect(diff.undeclared).toEqual([]);
    expect(diff.unused).toEqual([]);
  });

  it('does not read a malformed placeholder as a slot', () => {
    const diff = diffTemplateSlots('{focus} {{ }} {{no-dashes}} {{ok_1}}', ['ok_1']);

    expect(diff.used).toEqual(['ok_1']);
    expect(diff.undeclared).toEqual([]);
    expect(diff.unused).toEqual([]);
  });

  it('agrees with extractSlots about what a body uses', () => {
    const body = 'Hook {{focus}}\n\nProof {{proofPoint}}\n\nClose {{priceLine}}';
    expect(diffTemplateSlots(body, []).used).toEqual(extractSlots(body));
  });
});

describe('the built-in library', () => {
  it('declares only slots the drafting pipeline can fill', () => {
    const known = new Set<string>(TEMPLATE_SLOTS);
    for (const template of TEMPLATES) {
      for (const slot of templateSlots(template)) {
        expect(known.has(slot), `${template.id} uses unknown slot ${slot}`).toBe(true);
      }
    }
  });

  it('has a body and its slot list in agreement for every template', () => {
    for (const template of TEMPLATES) {
      const body = [template.hook, template.proof, template.plan, template.question, template.cta].join('\n\n');
      const diff = diffTemplateSlots(body, templateSlots(template));
      expect(diff.undeclared, template.id).toEqual([]);
      expect(diff.unused, template.id).toEqual([]);
    }
  });
});

describe('renderSlots', () => {
  it('throws naming every unfilled slot rather than emitting a hole', () => {
    expect(() => renderSlots('{{focus}} {{priceLine}}', { focus: 'the work' })).toThrowError(
      /unresolved template slots.*priceLine/,
    );
  });

  it('rejects a blank value the same way it rejects a missing one', () => {
    expect(() => renderSlots('{{focus}}', { focus: '   ' })).toThrowError(/focus/);
  });

  it('fills every slot of a built-in template when all values are present', () => {
    const template = TEMPLATES[0];
    const vars = Object.fromEntries(templateSlots(template).map((slot) => [slot, `value-${slot}`]));
    const letter = renderTemplate(template, vars);

    expect(letter).not.toMatch(/\{\{/);
    for (const slot of templateSlots(template)) {
      expect(letter).toContain(`value-${slot}`);
    }
  });
});
