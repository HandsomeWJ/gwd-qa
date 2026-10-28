// Keeps what the GWD Ad QA site sends to its owner's Google Drive: a copy of every ad checked there,
// for KEEP_DAYS days, and every bug report until the owner deletes it. It runs as the owner and is
// deployed as a web app that anyone can call, so it caps what it takes in.
//
// Setup, once: run setup() from the editor and allow what it asks for, then Deploy > New deployment >
// Web app, with Execute as: Me and Who has access: Anyone. The site is built with that deployment's
// /exec URL (VITE_RECORD_URL in .github/workflows/deploy.yml).

const KEEP_DAYS = 7;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const DAILY_CALLS = 500; // a flood of calls stops here instead of filling the Drive
const EMAIL_BUG_REPORTS = true; // each bug report is also emailed to the owner

const NAMES = { root: 'GWD QA records', uploads: `Uploads (kept ${KEEP_DAYS} days)`, bugs: 'Bug reports' };

/** Makes the folders, and the daily trigger that deletes uploads older than KEEP_DAYS. */
function setup() {
  const { root } = folders_();
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === 'purge') ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger('purge').timeBased().everyDays(1).atHour(3).create();
  console.log(`Ready: records go to ${root.getUrl()}, sent from ${Session.getEffectiveUser().getEmail()}`);
}

function doGet() {
  return reply_({ ok: true });
}

function doPost(e) {
  try {
    if (!countCall_()) return reply_({ ok: false, error: 'Too many reports today. Try again tomorrow.' });
    const body = JSON.parse(e.postData.contents);
    if (body.kind === 'upload') return reply_(saveUpload_(body));
    if (body.kind === 'bug') return reply_(saveBug_(body));
    return reply_({ ok: false, error: 'Unknown kind.' });
  } catch (err) {
    console.error(err);
    return reply_({ ok: false, error: String((err && err.message) || err) });
  }
}

/** The ad as it was picked, in a folder per day, with what the site said about it as its description. */
function saveUpload_(body) {
  const at = new Date();
  const day = child_(folders_().uploads, stamp_(at, 'yyyy-MM-dd'));
  const name = `${stamp_(at, 'HH-mm-ss')} ${clean_(body.file ? body.file.name : body.name)}`;
  const about = text_(body.about, 4000);
  // An ad over the size limit is noted by name only.
  const file = body.file && body.file.data
    ? day.createFile(blob_(body.file, name))
    : day.createFile(`${name}.txt`, about, MimeType.PLAIN_TEXT);
  file.setDescription(about);
  return { ok: true };
}

/** A folder per report: what went wrong and the page's state, the ad as picked, and its fixed HTML. */
function saveBug_(body) {
  const at = new Date();
  const description = text_(body.description, 20000).trim();
  if (!description) return { ok: false, error: 'Say what went wrong.' };
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email || '')) ? String(body.email) : '';
  const title = clean_(description.split('\n')[0]).slice(0, 60);
  const folder = folders_().bugs.createFolder(`${stamp_(at, 'yyyy-MM-dd HH-mm')} ${title}`);
  const report = [`What went wrong:\n${description}`, `Reply to: ${email || 'not given'}`, text_(body.about, 50000)].join('\n\n');
  folder.createFile('report.txt', report, MimeType.PLAIN_TEXT);
  if (body.file && body.file.data) folder.createFile(blob_(body.file, clean_(body.file.name)));
  if (body.fixed && body.fixed.data) folder.createFile(blob_(body.fixed, clean_(body.fixed.name)));
  if (EMAIL_BUG_REPORTS) {
    const mail = { to: Session.getEffectiveUser().getEmail(), subject: `GWD QA bug: ${title}`, body: `${report}\n\nFiles: ${folder.getUrl()}` };
    if (email) mail.replyTo = email;
    MailApp.sendEmail(mail);
  }
  return { ok: true };
}

/** Moves uploads older than KEEP_DAYS to the Drive trash, which empties itself after 30 days. */
function purge() {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const days = folders_().uploads.searchFolders('trashed = false');
  while (days.hasNext()) {
    const day = days.next();
    let left = 0;
    const files = day.searchFiles('trashed = false');
    while (files.hasNext()) {
      const file = files.next();
      if (file.getDateCreated().getTime() < cutoff) file.setTrashed(true);
      else left++;
    }
    if (!left && day.getDateCreated().getTime() < cutoff) day.setTrashed(true);
  }
}

/** The record folders, made again if they were deleted. Their ids are kept in the script's properties. */
function folders_() {
  const props = PropertiesService.getScriptProperties();
  const get = (key, parent) => {
    const id = props.getProperty(key);
    if (id) {
      try {
        const folder = DriveApp.getFolderById(id);
        if (!folder.isTrashed()) return folder;
      } catch (err) {
        // deleted for good: make it again
      }
    }
    const folder = parent.createFolder(NAMES[key]);
    props.setProperty(key, folder.getId());
    return folder;
  };
  const root = get('root', DriveApp.getRootFolder());
  return { root, uploads: get('uploads', root), bugs: get('bugs', root) };
}

/** The folder called `name` in `parent`, made under a lock so two calls at once make one. */
function child_(parent, name) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const found = parent.getFoldersByName(name);
    while (found.hasNext()) {
      const folder = found.next();
      if (!folder.isTrashed()) return folder;
    }
    return parent.createFolder(name);
  } finally {
    lock.releaseLock();
  }
}

/** Counts today's calls; false once there have been DAILY_CALLS. */
function countCall_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const today = stamp_(new Date(), 'yyyy-MM-dd');
    const [day, n] = String(props.getProperty('calls') || '').split(' ');
    const count = day === today ? Number(n) + 1 : 1;
    props.setProperty('calls', `${today} ${count}`);
    return count <= DAILY_CALLS;
  } finally {
    lock.releaseLock();
  }
}

function blob_(file, name) {
  if (typeof file.data !== 'string' || file.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error('The file is too big.');
  return Utilities.newBlob(Utilities.base64Decode(file.data), String(file.type || 'application/octet-stream'), name);
}

const stamp_ = (at, pattern) => Utilities.formatDate(at, Session.getScriptTimeZone(), pattern);
const text_ = (value, max) => String(value == null ? '' : value).slice(0, max);
// Drive takes any name, but these keep names readable and safe to download. Built from a string: with
// a slash and a quote in a regex literal, the Apps Script editor listed none of the script's functions.
const UNSAFE_ = new RegExp('[\\u0000-\\u001f\\\\/:*?"<>|]+', 'g');
const clean_ = (name) => String(name || 'ad').replace(UNSAFE_, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'ad';

function reply_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
