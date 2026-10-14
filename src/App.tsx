import {
  ArrowDownToLine,
  Check,
  Eye,
  EyeOff,
  ImagePlus,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  ScanFace,
  Sparkles,
  Star,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { exportJpeg, renderOverlay, type Swap } from './engine/compose';
import { correspond, eyesLookClosed, eyesReadable, quality, rankCandidates, suggestedFix, type Match } from './engine/match';
import { FriendlyError, prepareModels, readPhoto, type Face, type Photo } from './engine/vision';

const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
const STANDALONE = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
// On iPhone a plain image/* picker opens the Photos library and hands HEIC photos over as JPEGs.
const ACCEPT = IS_IOS ? 'image/*' : 'image/*,.jpg,.jpeg,.jfif,.png,.webp,.heic,.heif';
const HINT_KEY = 'good-take:home-screen-hint-dismissed';

function hintDismissed() {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}
const IMAGE_NAME = /\.(jpe?g|jfif|png|webp|gif|bmp|avif|heic|heif)$/i;

function explain(error: unknown, fileName: string) {
  if (error instanceof FriendlyError) return error.message;
  console.error(error);
  return `Something went wrong with "${fileName}". Please try a different photo.`;
}

/** The photo with the most people in it, then the most open eyes, makes the best starting point. */
function pickMain(photos: Photo[]) {
  const score = (photo: Photo) => photo.faces.length * 10 + photo.faces.reduce((sum, face) => sum + quality(face), 0);
  return photos.reduce((best, photo) => (score(photo) > score(best) ? photo : best));
}

function OptionTile({ face, title, star, active, onClick }: {
  face: Face; title: string; star?: boolean; active: boolean; onClick: () => void;
}) {
  return (
    <button className={active ? 'option active' : 'option'} onClick={onClick} type="button" aria-pressed={active}>
      <img src={face.thumb} alt="" />
      {active && <span className="option-check"><Check size={16} strokeWidth={3} /></span>}
      <span className="option-title">{star && <Star size={13} fill="currentColor" />}{title}</span>
      {eyesReadable(face) && (
        <span className={eyesLookClosed(face) ? 'option-note warn' : 'option-note'}>
          {eyesLookClosed(face) ? <><EyeOff size={13} />Eyes closed</> : <><Eye size={13} />Eyes open</>}
        </span>
      )}
    </button>
  );
}

export default function App() {
  const fileInput = useRef<HTMLInputElement>(null);
  const baseCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const pickerRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [mainId, setMainId] = useState('');
  // Target face id → chosen donor face id ('' means the person was looked at and kept as taken).
  const [swaps, setSwaps] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showEveryone, setShowEveryone] = useState(false);
  const [busy, setBusy] = useState<{ text: string; progress: number } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  // iPhone: a finished photo waiting for a tap to open the share sheet (Safari needs a fresh tap).
  const [pendingShare, setPendingShare] = useState<File | null>(null);
  const [showHomeHint, setShowHomeHint] = useState(() => IS_IOS && !STANDALONE && !hintDismissed());

  const main = photos.find((photo) => photo.id === mainId) ?? photos[0];
  const others = useMemo(() => photos.filter((photo) => photo.id !== main?.id), [photos, main]);
  const faceIndex = useMemo(
    () => new Map(photos.flatMap((photo) => photo.faces.map((face) => [face.id, { face, photo }] as const))),
    [photos],
  );
  const matches = useMemo(() => {
    const result = new Map<string, Map<string, Match>>();
    if (main) for (const photo of others) result.set(photo.id, correspond(main, photo));
    return result;
  }, [main, others]);
  const candidates = useMemo(
    () => new Map((main?.faces ?? []).map((face) => [face.id, rankCandidates(face, others, matches)])),
    [main, others, matches],
  );
  const suggestions = (main?.faces ?? []).flatMap((face) => {
    const fix = suggestedFix(face, candidates.get(face.id) ?? []);
    return fix && swaps[face.id] === undefined ? [{ target: face, donor: fix.face }] : [];
  });
  const activeSwaps: Swap[] = (main?.faces ?? []).flatMap((target) => {
    const donor = swaps[target.id] ? faceIndex.get(swaps[target.id]) : undefined;
    return donor ? [{ target, donor: donor.face, donorPhoto: donor.photo }] : [];
  });
  const changed = activeSwaps.length > 0;
  const selected = main?.faces.find((face) => face.id === selectedId);
  const photoNumber = (photo: Photo) => photos.indexOf(photo) + 1;

  useEffect(() => {
    const canvas = baseCanvas.current;
    if (!canvas || !main) return;
    canvas.width = main.width;
    canvas.height = main.height;
    canvas.getContext('2d')?.drawImage(main.bitmap, 0, 0);
  }, [main]);

  const swapKey = activeSwaps.map((swap) => `${swap.target.id}>${swap.donor.id}`).join();
  useEffect(() => {
    const canvas = overlayCanvas.current;
    if (!canvas || !main) return;
    try {
      renderOverlay(canvas, main, activeSwaps);
    } catch (error) {
      setProblems([explain(error, main.name)]);
    }
    // activeSwaps is rebuilt each render; swapKey captures what it contains.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [main, swapKey]);

  useEffect(() => {
    if (!selectedId) return;
    // On phones the choices sit under the photo, so keep the photo in view to show each change.
    if (window.matchMedia('(max-width: 960px)').matches) stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else pickerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedId]);

  async function addFiles(files: File[]) {
    if (busy || !files.length) return;
    const images = files.filter((file) => file.type.startsWith('image/') || IMAGE_NAME.test(file.name));
    if (!images.length) {
      setProblems(["Those files don't look like photos. Please choose JPG or PNG pictures."]);
      return;
    }
    setProblems([]);
    setSaved('');
    setBusy({ text: 'Getting ready… the first time takes a few seconds', progress: 0 });
    try {
      await prepareModels();
    } catch (error) {
      setProblems([explain(error, images[0].name)]);
      setBusy(null);
      return;
    }
    const added: Photo[] = [];
    const issues: string[] = [];
    for (const [index, file] of images.entries()) {
      try {
        const photo = await readPhoto(file, (fraction) => setBusy({
          text: images.length > 1 ? `Looking for faces in photo ${index + 1} of ${images.length}…` : 'Looking for faces…',
          progress: (index + fraction) / images.length,
        }));
        if (photo.faces.length) added.push(photo);
        else {
          photo.bitmap.close();
          issues.push(`No faces were found in "${file.name}". Faces should be looking toward the camera and not too tiny.`);
        }
      } catch (error) {
        issues.push(explain(error, file.name));
      }
    }
    setPhotos((current) => [...current, ...added]);
    if (!main && added.length) setMainId(pickMain(added).id);
    setProblems(issues);
    setBusy(null);
  }

  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files');
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      // Without this the browser navigates away to show the dropped picture.
      event.preventDefault();
      setDragging(false);
      void addFilesRef.current(Array.from(event.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  function choose(targetId: string, donorId: string) {
    setSwaps((current) => ({ ...current, [targetId]: donorId }));
    setSaved('');
  }

  function fixAll() {
    setSwaps((current) => ({ ...current, ...Object.fromEntries(suggestions.map((s) => [s.target.id, s.donor.id])) }));
    setSaved('');
  }

  function switchMain(photo: Photo) {
    if (photo.id === main?.id) return;
    if (changed && !window.confirm('Use this as the main photo instead? The faces you changed will be reset.')) return;
    setMainId(photo.id);
    setSwaps({});
    setSelectedId(null);
    setSaved('');
  }

  function startOver() {
    if (changed && !window.confirm('Start over? Your changes will be cleared (your original photos are not affected).')) return;
    photos.forEach((photo) => photo.bitmap.close());
    setPhotos([]);
    setMainId('');
    setSwaps({});
    setSelectedId(null);
    setProblems([]);
    setSaved('');
  }

  async function save() {
    if (!main || saving) return;
    setSaving(true);
    setSaved('');
    setPendingShare(null);
    try {
      const blob = await exportJpeg(main, activeSwaps);
      const name = `${main.name.replace(/\.[^.]+$/, '')}-fixed.jpg`;
      const photo = new File([blob], name, { type: 'image/jpeg' });
      if (IS_IOS && navigator.canShare?.({ files: [photo] })) {
        // The share sheet's "Save Image" puts it straight into the Photos app.
        await shareToPhotos(photo);
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setSaved(`Saved! Look in your Downloads folder for "${name}".`);
    } catch (error) {
      setProblems([explain(error, main.name)]);
    } finally {
      setSaving(false);
    }
  }

  async function shareToPhotos(photo: File) {
    try {
      await navigator.share({ files: [photo] });
      setPendingShare(null);
      setSaved('Done! If you tapped "Save Image", it\'s in your Photos.');
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      // Closed the sheet, or Safari wanted a fresh tap: offer a button that opens it again.
      if (name === 'AbortError' || name === 'NotAllowedError') setPendingShare(photo);
      else throw error;
    }
  }

  function dismissHomeHint() {
    setShowHomeHint(false);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // Private browsing can refuse storage; the hint just shows again next time.
    }
  }

  const holdCompare = {
    onPointerDown: () => setComparing(true),
    onPointerUp: () => setComparing(false),
    onPointerLeave: () => setComparing(false),
    onPointerCancel: () => setComparing(false),
    onKeyDown: (event: KeyboardEvent) => { if (event.key === ' ' || event.key === 'Enter') setComparing(true); },
    onKeyUp: () => setComparing(false),
    onContextMenu: (event: MouseEvent) => event.preventDefault(),
  };

  const selectedCandidates = selected ? candidates.get(selected.id) ?? [] : [];
  const everyoneElse = selected
    ? others.flatMap((photo) => photo.faces
      .filter((face) => !selectedCandidates.some((candidate) => candidate.face.id === face.id))
      .map((face) => ({ face, photo })))
    : [];
  const guide = photos.length === 1
    ? 'Add at least one more photo of the same moment, so there are better faces to choose from.'
    : selected
      ? 'Now tap the face you like best in the list.'
      : 'Tap any face in the picture to change it.';

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand"><span className="brand-mark"><ScanFace size={20} /></span>Fix Bad Face <small className="plain-tag">Plain</small></span>
        <span className="private"><LockKeyhole size={15} />Your photos never leave this device</span>
      </header>

      <main className="page">
        {showHomeHint && !main && (
          <div className="home-hint">
            <span>Keep this as an app: tap the <b>Share</b> button, then <b>Add to Home Screen</b>.</span>
            <button className="close" onClick={dismissHomeHint} type="button" aria-label="Dismiss"><X size={18} /></button>
          </div>
        )}
        {!main && !busy && (
          <section className="welcome">
            <h1>Everyone's best face,<br /><em>in one photo.</em></h1>
            <p className="lead">Took a few pictures in a row and someone blinked in the good one? Add them here and pick a better face for anyone.</p>
            <ol className="steps">
              <li><b>1</b><span>Add 2 or more photos taken at the same moment</span></li>
              <li><b>2</b><span>Tap a face you want to change</span></li>
              <li><b>3</b><span>Pick a better one, then press Save</span></li>
            </ol>
            <button className="drop-target" onClick={() => fileInput.current?.click()} type="button">
              <Upload size={30} />
              <strong>Fix a bad face</strong>
              <span>{IS_IOS ? 'Pick 2 or more photos from your library' : 'Choose photos, or drag them onto this page'}</span>
            </button>
          </section>
        )}

        {busy && (
          <section className="working" aria-live="polite">
            <LoaderCircle className="spin" size={26} />
            <p>{busy.text}</p>
            <div className="progress"><span style={{ width: `${Math.round(busy.progress * 100)}%` }} /></div>
          </section>
        )}

        {problems.length > 0 && (
          <div className="problems" role="alert">
            <ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
            <button className="text-button" onClick={() => setProblems([])} type="button">OK</button>
          </div>
        )}

        {main && (
          <section className="editor">
            <div className="stage-column">
              <p className="guide">{guide}</p>
              {suggestions.length > 0 && (
                <div className="suggestion">
                  <EyeOff size={20} />
                  <span>{suggestions.length === 1 ? 'Someone has their eyes closed.' : `${suggestions.length} people have their eyes closed.`}</span>
                  <button className="button primary" onClick={fixAll} type="button"><Sparkles size={17} />Fix it for me</button>
                </div>
              )}
              <div className="stage" ref={stageRef} style={{ aspectRatio: `${main.width} / ${main.height}`, width: `min(100%, calc(72vh * ${main.width / main.height}))` }}>
                <canvas ref={baseCanvas} className="layer" aria-label="Your main photo" />
                <canvas ref={overlayCanvas} className="layer" style={{ visibility: comparing ? 'hidden' : 'visible' }} />
                {comparing ? <span className="stage-tag">Original</span> : main.faces.map((face, index) => {
                  const replaced = !!swaps[face.id];
                  const closed = !replaced && eyesLookClosed(face);
                  return (
                    <button
                      className={['ring', face.id === selectedId && 'selected', replaced && 'replaced', closed && 'closed'].filter(Boolean).join(' ')}
                      key={face.id}
                      onClick={() => { setSelectedId(face.id); setShowEveryone(false); }}
                      style={{
                        left: `${((face.box.x - face.box.w * 0.14) / main.width) * 100}%`,
                        top: `${((face.box.y - face.box.h * 0.1) / main.height) * 100}%`,
                        width: `${((face.box.w * 1.28) / main.width) * 100}%`,
                        height: `${((face.box.h * 1.2) / main.height) * 100}%`,
                      }}
                      type="button"
                      aria-label={`Person ${index + 1}${closed ? ', eyes look closed' : ''}${replaced ? ', face changed' : ''}`}
                    >
                      <span className="ring-badge">{replaced ? <Check size={14} strokeWidth={3} /> : closed ? <EyeOff size={14} /> : index + 1}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="actions-area">
              <div className="actions">
                <button className="button primary large" disabled={!changed || saving} onClick={() => void save()} type="button">
                  {saving ? <><LoaderCircle className="spin" size={20} />Saving…</> : <><ArrowDownToLine size={20} />Save photo</>}
                </button>
                <button className="button large" disabled={!changed} type="button" {...holdCompare}><Eye size={20} />Hold to see original</button>
                {changed && <button className="text-button" onClick={() => { setSwaps({}); setSaved(''); }} type="button"><RotateCcw size={16} />Undo changes</button>}
              </div>
              {pendingShare && (
                <div className="share-ready">
                  <span>Your fixed photo is ready.</span>
                  <button className="button primary large" onClick={() => void shareToPhotos(pendingShare).catch((error) => setProblems([explain(error, pendingShare.name)]))} type="button">
                    <ArrowDownToLine size={20} />Save to Photos
                  </button>
                  <small>Then tap <b>Save Image</b>.</small>
                </div>
              )}
              {saved && <p className="saved"><Check size={18} />{saved}</p>}
            </div>

            <aside className="side">
              {selected && (
                <section className="picker" ref={pickerRef} aria-label="Choose a face">
                  <div className="picker-head">
                    <img src={selected.thumb} alt="" />
                    <div>
                      <h2>Person {main.faces.indexOf(selected) + 1}</h2>
                      <p>Tap the face you like best. You'll see it in the picture right away.</p>
                    </div>
                    <button className="close" onClick={() => setSelectedId(null)} type="button" aria-label="Close"><X size={20} /></button>
                  </div>
                  <div className="options">
                    <OptionTile
                      face={selected}
                      title="As taken"
                      active={!swaps[selected.id]}
                      onClick={() => choose(selected.id, '')}
                    />
                    {selectedCandidates.map((candidate, index) => {
                      const best = index === 0 && candidate.quality > quality(selected) + 0.05;
                      return (
                        <OptionTile
                          key={candidate.face.id}
                          face={candidate.face}
                          title={best ? 'Best pick' : `From photo ${photoNumber(candidate.photo)}`}
                          star={best}
                          active={swaps[selected.id] === candidate.face.id}
                          onClick={() => choose(selected.id, candidate.face.id)}
                        />
                      );
                    })}
                  </div>
                  {selectedCandidates.length === 0 && (
                    <p className="hint">
                      {others.length
                        ? "We couldn't spot this person in your other photos. Tap \"Show everyone\" to pick them yourself."
                        : 'Add another photo of the same moment to get choices.'}
                    </p>
                  )}
                  {everyoneElse.length > 0 && (
                    <button className="text-button" onClick={() => setShowEveryone((value) => !value)} type="button">
                      <Users size={16} />{showEveryone ? 'Hide the other faces' : 'Not the right person? Show everyone'}
                    </button>
                  )}
                  {showEveryone && (
                    <div className="options compact">
                      {everyoneElse.map(({ face, photo }) => (
                        <OptionTile
                          key={face.id}
                          face={face}
                          title={`Photo ${photoNumber(photo)}`}
                          active={swaps[selected.id] === face.id}
                          onClick={() => choose(selected.id, face.id)}
                        />
                      ))}
                    </div>
                  )}
                  <button className="button primary large done" onClick={() => setSelectedId(null)} type="button"><Check size={20} />Done</button>
                </section>
              )}

              <section className="photos">
                <h2>Your photos</h2>
                <p>The big picture is your main photo. Tap another one to use it instead.</p>
                <div className="photo-grid">
                  {photos.map((photo) => (
                    <button className={photo.id === main.id ? 'photo-tile main' : 'photo-tile'} key={photo.id} onClick={() => switchMain(photo)} type="button" aria-pressed={photo.id === main.id}>
                      <img src={photo.thumb} alt="" />
                      <span>{photo.id === main.id ? 'Main photo' : `Photo ${photoNumber(photo)}`}</span>
                      <small>{photo.faces.length} {photo.faces.length === 1 ? 'face' : 'faces'}</small>
                    </button>
                  ))}
                  <button className="photo-tile add" onClick={() => fileInput.current?.click()} type="button" disabled={!!busy}>
                    <ImagePlus size={26} />
                    <span>Add photos</span>
                  </button>
                </div>
                <button className="text-button quiet" onClick={startOver} type="button">Start over</button>
              </section>
            </aside>
          </section>
        )}

        <details className="how">
          <summary>How does it know who is who?</summary>
          <div className="how-body">
            <p>
              This is the <b>plain</b> version of Fix Bad Face, made to compare against the original. It works the way a camera-burst feature does:
              it assumes the camera stayed still, so each person is matched to whoever is at the same spot in the other photo and looks most alike.
              The original instead uses analogy (structure-mapping) to find the one arrangement the whole group agrees on, so it keeps working when the camera moves.
            </p>
            <ul>
              <li><b>Finding faces.</b> Each photo is scanned whole and in smaller overlapping pieces, so small faces in big group photos are found too.</li>
              <li><b>Who is who.</b> Each face is paired with the face at the same place in the other photo that also looks most alike (face, hair, skin and clothing colour). Each person is placed on their own.</li>
              <li><b>Best face.</b> Every match is scored once for open eyes, sharpness, smile and head angle.</li>
              <li><b>Fitting it in.</b> The new face is turned and resized to the original head, keeping its open eyes and expression, then its lighting is matched and the edges are softened.</li>
            </ul>
            <p className="fine">Everything runs inside your browser. The face finder downloads once from Google MediaPipe. Your original files are never changed. Please only edit photos of people who'd be happy with it.</p>
          </div>
        </details>
      </main>

      {dragging && <div className="drop-overlay"><Upload size={40} /><p>Drop your photos here</p></div>}
      <input
        ref={fileInput}
        accept={ACCEPT}
        className="visually-hidden"
        multiple
        onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }}
        type="file"
      />
    </div>
  );
}
