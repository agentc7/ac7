/**
 * Renders of MessageAttachments — verifies image inline (with click-
 * through link to `/fs/read/...`) and non-image chip (with download
 * href). Size rendering is a sanity-check so the sidebar copy stays
 * consistent with what the wire ships.
 */

import type { Attachment } from '@agentc7/sdk/types';
import { render } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { MessageAttachments } from '../src/components/MessageAttachments.js';

const img: Attachment = {
  path: '/alice/uploads/photo.png',
  name: 'photo.png',
  size: 2048,
  mimeType: 'image/png',
};

const doc: Attachment = {
  path: '/alice/uploads/report.pdf',
  name: 'report.pdf',
  size: 1024 * 1024 * 2,
  mimeType: 'application/pdf',
};

describe('MessageAttachments', () => {
  it('returns nothing for an empty attachments array', () => {
    const { container } = render(<MessageAttachments attachments={[]} />);
    expect(container.textContent).toBe('');
  });

  it('renders images inline with a click-through to /fs/read', () => {
    const { container } = render(<MessageAttachments attachments={[img]} />);
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toBe('/fs/read/alice/uploads/photo.png');
    expect(image?.getAttribute('alt')).toBe('photo.png');
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('/fs/read/alice/uploads/photo.png');
  });

  it('renders non-images as download chips with size + mime', () => {
    const { container } = render(<MessageAttachments attachments={[doc]} />);
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('/fs/read/alice/uploads/report.pdf');
    expect(anchor?.getAttribute('download')).toBe('report.pdf');
    expect(container.textContent).toContain('report.pdf');
    expect(container.textContent).toContain('2.0 MB');
  });

  it('renders a mix in order', () => {
    const { container } = render(<MessageAttachments attachments={[doc, img]} />);
    const anchors = container.querySelectorAll('a');
    expect(anchors).toHaveLength(2);
    expect(anchors[0]?.getAttribute('href')).toBe('/fs/read/alice/uploads/report.pdf');
    expect(anchors[1]?.getAttribute('href')).toBe('/fs/read/alice/uploads/photo.png');
  });
});
