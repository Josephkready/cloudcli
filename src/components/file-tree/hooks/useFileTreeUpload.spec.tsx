import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../types/app';

import { useFileTreeUpload } from './useFileTreeUpload';

class DeferredUploadRequest {
  static instances: DeferredUploadRequest[] = [];

  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  responseText = '';
  status = 0;

  constructor() {
    DeferredUploadRequest.instances.push(this);
  }

  open() {}
  setRequestHeader() {}
  getResponseHeader() { return null; }
  send() {}
}

const project = {
  projectId: 'project-1',
  displayName: 'Demo',
  path: '/workspace/demo',
  fullPath: '/workspace/demo',
} satisfies Project;

describe('useFileTreeUpload concurrency', () => {
  beforeEach(() => {
    DeferredUploadRequest.instances = [];
    vi.stubGlobal('XMLHttpRequest', DeferredUploadRequest);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ignores a second upload while the first request is in flight', async () => {
    const showToast = vi.fn();
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useFileTreeUpload({
      selectedProject: project,
      onRefresh,
      showToast,
    }));
    const firstFile = new File(['first'], 'first.txt', { type: 'text/plain' });
    const secondFile = new File(['second'], 'second.txt', { type: 'text/plain' });

    let firstUpload: Promise<void>;
    act(() => {
      firstUpload = result.current.handleFileSelect([firstFile]);
    });
    await waitFor(() => expect(DeferredUploadRequest.instances).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect([secondFile]);
    });
    expect(DeferredUploadRequest.instances).toHaveLength(1);
    expect(result.current.operationLoading).toBe(true);

    const request = DeferredUploadRequest.instances[0];
    request.status = 200;
    request.responseText = JSON.stringify({ uploadedCount: 1, requestedFileCount: 1 });
    await act(async () => {
      request.onload?.();
      await firstUpload!;
    });

    expect(result.current.operationLoading).toBe(false);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Uploaded 1 file successfully', 'success');
  });
});
