import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useScreenshotLightbox } from '../../src/pipenzo/use-screenshot-lightbox.js';

describe('useScreenshotLightbox', () => {
  it('starts with nothing open', () => {
    const { result } = renderHook(() => useScreenshotLightbox(3));
    expect(result.current.activeIndex).toBeUndefined();
  });

  it('open() sets the active index', () => {
    const { result } = renderHook(() => useScreenshotLightbox(3));
    act(() => result.current.open(1));
    expect(result.current.activeIndex).toBe(1);
  });

  it('close() clears the active index', () => {
    const { result } = renderHook(() => useScreenshotLightbox(3));
    act(() => result.current.open(1));
    act(() => result.current.close());
    expect(result.current.activeIndex).toBeUndefined();
  });

  it('next() wraps around from the last index to the first', () => {
    const { result } = renderHook(() => useScreenshotLightbox(2));
    act(() => result.current.open(1));
    act(() => result.current.next());
    expect(result.current.activeIndex).toBe(0);
  });

  it('prev() wraps around from the first index to the last', () => {
    const { result } = renderHook(() => useScreenshotLightbox(2));
    act(() => result.current.open(0));
    act(() => result.current.prev());
    expect(result.current.activeIndex).toBe(1);
  });

  it('prev()/next() are no-ops while nothing is open', () => {
    const { result } = renderHook(() => useScreenshotLightbox(2));
    act(() => result.current.next());
    expect(result.current.activeIndex).toBeUndefined();
    act(() => result.current.prev());
    expect(result.current.activeIndex).toBeUndefined();
  });
});
