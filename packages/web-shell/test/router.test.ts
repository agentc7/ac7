import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRouterForTests, currentRoute, navigate } from '../src/lib/router.js';

describe('router', () => {
  beforeEach(() => {
    __resetRouterForTests();
  });

  it('boots to home by default', () => {
    expect(currentRoute.value).toEqual({ kind: 'home' });
  });

  it('navigate updates the signal and the URL', () => {
    navigate({ kind: 'objectives-list' });
    expect(currentRoute.value).toEqual({ kind: 'objectives-list' });
    expect(window.location.pathname).toBe('/objectives');
  });

  it('navigate no-ops when target matches current', () => {
    navigate({ kind: 'objectives-list' });
    const historyLenBefore = window.history.length;
    navigate({ kind: 'objectives-list' });
    expect(window.history.length).toBe(historyLenBefore);
  });

  it('navigate with replace does not add to history', () => {
    const before = window.history.length;
    navigate({ kind: 'inbox' }, { replace: true });
    expect(currentRoute.value).toEqual({ kind: 'inbox' });
    expect(window.location.pathname).toBe('/inbox');
    expect(window.history.length).toBe(before);
  });

  it('popstate updates the signal from the URL', () => {
    navigate({ kind: 'objectives-list' });
    navigate({ kind: 'thread-primary' });
    expect(currentRoute.value).toEqual({ kind: 'thread-primary' });
    // Simulate back button: change the URL + dispatch popstate.
    window.history.replaceState(null, '', '/objectives');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(currentRoute.value).toEqual({ kind: 'objectives-list' });
  });
});
