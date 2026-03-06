import { useCallback, useMemo, useRef, useState } from 'react';
import { runOemerBridge } from '../ingest/oemerBridge';
import { emitCsmpnFakebook, parseMusicXmlForFakebook } from '../parsers/musicXmlToCsmpnFakebook';

interface Props {
  onImportCsmpn?: (csmpnText: string) => void;
}

type Step = 'idle' | 'loading-images' | 'running-oemer' | 'parsing-musicxml' | 'generating-csmpn' | 'done' | 'error';

const ACCEPT = '.png,image/png,.jpg,.jpeg,image/jpeg';

export default function OemerImageImporterPanel({ onImportCsmpn }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [step, setStep] = useState<Step>('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [musicXml, setMusicXml] = useState('');
  const [csmpnText, setCsmpnText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const sortedFiles = useMemo(
    () => [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    [files],
  );

  const appendLog = useCallback((line: string) => {
    setLogs((prev) => [...prev, line]);
  }, []);

  const handleFiles = useCallback((fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const next = Array.from(fileList).filter((file) => /\.(png|jpg|jpeg)$/i.test(file.name));
    setFiles(next);
    setStep('idle');
    setLogs([`Queued ${next.length} image file(s).`]);
    setError('');
    setMusicXml('');
    setCsmpnText('');
  }, []);

  const onRun = useCallback(async () => {
    if (sortedFiles.length === 0) {
      setError('Please upload one or more PNG images first.');
      setStep('error');
      return;
    }

    setError('');
    setLogs([]);

    setStep('loading-images');
    appendLog(`loading images: ${sortedFiles.map((file) => file.name).join(', ')}`);

    setStep('running-oemer');
    appendLog('running OEMER...');
    const bridgeResult = await runOemerBridge(sortedFiles);
    for (const line of bridgeResult.logs) appendLog(`oemer: ${line}`);

    if (!bridgeResult.ok) {
      setError(`${bridgeResult.code}: ${bridgeResult.message}`);
      setStep('error');
      appendLog('OEMER failed. Structured error returned.');
      return;
    }

    setMusicXml(bridgeResult.musicXml);

    setStep('parsing-musicxml');
    appendLog('parsing MusicXML...');
    let csmpn: string;
    try {
      const parsed = parseMusicXmlForFakebook(bridgeResult.musicXml);
      setStep('generating-csmpn');
      appendLog('generating CSMPN...');
      csmpn = emitCsmpnFakebook(parsed);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError));
      setStep('error');
      return;
    }

    setCsmpnText(csmpn);
    setStep('done');
    appendLog('done.');
  }, [appendLog, sortedFiles]);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <h2>OEMER Image OMR (Fallback v1)</h2>
      <p style={{ margin: 0, color: '#475569' }}>
        Upload one image per page (PNG preferred), named in page order.
      </p>

      <div
        style={{ border: '1px dashed #64748b', borderRadius: 10, padding: 16, background: '#f8fafc' }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          style={{ display: 'none' }}
        />
        <button type="button" onClick={() => inputRef.current?.click()}>Upload page images</button>
        <div style={{ marginTop: 10, fontSize: 13 }}>
          {sortedFiles.length === 0 ? 'No files selected.' : sortedFiles.map((file) => file.name).join(', ')}
        </div>
      </div>

      <div>
        <button type="button" onClick={() => void onRun()} disabled={step === 'running-oemer' || step === 'parsing-musicxml' || step === 'generating-csmpn'}>
          Run OEMER OMR
        </button>
      </div>

      {error && <div style={{ color: '#b91c1c', fontWeight: 600 }}>{error}</div>}

      <div style={{ background: '#0f172a', color: '#e2e8f0', borderRadius: 8, padding: 12, fontFamily: 'monospace', fontSize: 12, minHeight: 120 }}>
        <div>Status: {step}</div>
        {logs.map((line, idx) => <div key={`${line}-${idx}`}>{line}</div>)}
      </div>

      {csmpnText && (
        <>
          <button type="button" onClick={() => onImportCsmpn?.(csmpnText)}>Use This Chart</button>
          <textarea value={csmpnText} readOnly rows={10} style={{ width: '100%' }} />
        </>
      )}

      {musicXml && <details><summary>MusicXML output</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{musicXml}</pre></details>}
    </div>
  );
}
