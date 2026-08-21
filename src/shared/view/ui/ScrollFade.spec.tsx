import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ScrollFade } from './ScrollFade';

/*
 * #360: the fade overlays cue that a `scrollbar-hide` row has more content to
 * scroll. jsdom has no layout engine (scrollWidth/clientWidth are 0 and the
 * ResizeObserver stub never fires), so these drive the scroll geometry by hand
 * and dispatch a scroll event — exercising the useScrollFade → computeScrollFade
 * → opacity-class path that the pure test cannot reach.
 */
function setGeometry(el: HTMLElement, geo: { scrollLeft: number; scrollWidth: number; clientWidth: number }) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: geo.scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: geo.clientWidth });
  el.scrollLeft = geo.scrollLeft;
}

describe('ScrollFade', () => {
  it('renders both edge overlays as decorative (aria-hidden, non-interactive)', () => {
    const { container } = render(
      <ScrollFade>
        <div>content</div>
      </ScrollFade>,
    );
    const fades = container.querySelectorAll('[aria-hidden]');
    expect(fades.length).toBe(2);
    fades.forEach((fade) => expect(fade.className).toContain('pointer-events-none'));
  });

  it('shows only the right fade when scrolled to the start of an overflowing row', () => {
    const { container } = render(
      <ScrollFade>
        <div>content</div>
      </ScrollFade>,
    );
    const scroller = container.querySelector('.overflow-x-auto') as HTMLElement;
    const left = container.querySelector('.bg-gradient-to-r') as HTMLElement;
    const right = container.querySelector('.bg-gradient-to-l') as HTMLElement;

    setGeometry(scroller, { scrollLeft: 0, scrollWidth: 768, clientWidth: 364 });
    fireEvent.scroll(scroller);

    expect(left.className).toContain('opacity-0');
    expect(right.className).toContain('opacity-100');
  });

  it('shows only the left fade once scrolled to the end', () => {
    const { container } = render(
      <ScrollFade>
        <div>content</div>
      </ScrollFade>,
    );
    const scroller = container.querySelector('.overflow-x-auto') as HTMLElement;
    const left = container.querySelector('.bg-gradient-to-r') as HTMLElement;
    const right = container.querySelector('.bg-gradient-to-l') as HTMLElement;

    setGeometry(scroller, { scrollLeft: 404, scrollWidth: 768, clientWidth: 364 });
    fireEvent.scroll(scroller);

    expect(left.className).toContain('opacity-100');
    expect(right.className).toContain('opacity-0');
  });
});
