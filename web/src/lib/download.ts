/**
 * Saves bytes the page made (the encrypted cancel key) as a file: a Blob URL and an
 * `<a download>`. Nothing leaves the browser, and nothing is stored in it. The CSP
 * does not restrict this: a download is neither a fetch nor a script, and `href` is
 * not a Trusted Types sink.
 */
export function downloadBytes(bytes: Uint8Array, fileName: string, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking in the same task can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
