/* utils.js — Zero-dependency utility functions
   Extracted from index.html (Sprint 3, item 2.1A).
   Loaded as a plain script before the main inline script.
   All functions are global — no module system.
*/

/* ---- Performance: debounce helper ---- */
function debounce(fn, ms){
  let timer;
  return function(...args){
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

function escapeHtml(s){
  return (s ?? '').toString()
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

function safeFilename(name, fallback='chart'){
  const base = (name || fallback).toString().trim() || fallback;
  return base
    .replace(/[\\\/\:*?"<>|]+/g,'-')
    .replace(/\s+/g,' ')
    .trim()
    .slice(0, 80);
}

async function tryShareFile(file){
  try{
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
      return true;
    }
  }catch(_e){}
  return false;
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function normalizeAccidentals(s){
  return (s ?? '')
    .replace(/♭/g,'b')
    .replace(/♯/g,'#')
    .replace(/\u00A0/g,' ')
    .trim();
}
