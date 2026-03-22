const res = await fetch('vods.json', { cache: 'no-cache' });
const data = await res.json();
const vods = data.vods.reverse() || [];
const fmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });

const hm = s => {
	if (s == null) return '';
	const mins = Math.round(Number(s)/60);
	const h = Math.floor(mins/60);
	const m = (mins%60).toString().padStart(2, '0');
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const app = document.getElementById('app');
app.innerHTML = '';
if (!vods.length) {
	app.textContent = 'No VODs found.';
	throw new Error(app.textContent);
}

for (const v of vods) {
	const div = document.createElement('details');
	div.open = false;
	div.className = 'vod';

	const title = v.title || '(untitled)';
	const when = v.created_at;
	const dateStr = when ? fmt.format(new Date(when * 1000)) : '';
	const lenStr  = hm(v.duration_seconds);
	const chan    = v.channel || v.twitch_id || '';

	const titleRegex = /HSMA ([WS]S[0-9\/]+) (HTML|GCT2|VIR|VSTG|INT) (.*)/gi;
	const titleFormatted = title.replace(titleRegex, "<span class=\"semester\">$1</span> <span class=\"course\">$2</span> <span class=\"title-text\">$3</span>");
	console.log(titleFormatted);

	div.innerHTML = `
		<summary>
			<span class="title">${titleFormatted}</span>
			<span class="timestamp">${escapeHtml(dateStr)}</span>
			<span class="duration">${escapeHtml(lenStr)}</span>
		</summary>`;
	/*
	div.innerHTML += `
		<div class="vod-content">
			${v.id ? `<span class="badge v-id">ID: <code>${escapeHtml(v.id)}</code></span>` : ''}
			${chan ? `<span class="badge v-channel">Channel: ${escapeHtml(chan)}</span>` : ''}
			${dateStr ? `<span class="badge v-timestamp">Date: ${escapeHtml(dateStr)}</span>` : ''}
			${lenStr ? `<span class="badge v-duration">Length: ${escapeHtml(lenStr)}</span>` : ''}
		</div>
	`;
	*/

	const files = v.files || [];
	if (files.length) {
		const ul = document.createElement('ul');
		ul.className = 'files';
		// Show video-like files first
		const isVideo = f => /\.(mp4|mkv|m3u8|mov|ts|webm)\b/i.test(f.fileName || f.downloadUrl || '');
		const ordered = [...files].sort((a,b)=> Number(isVideo(b)) - Number(isVideo(a)));
		for (const f of ordered) {
			if (!isVideo(f)) continue; // skip non-video for now
			const li = document.createElement('li');
			li.className = 'file';
			const name = f.fileName || (f.downloadUrl ? new URL(f.downloadUrl).pathname.split('/').pop() : '(file)');
			const size = f.fileSize || (f.fileSizeRaw ? `${f.fileSizeRaw} B` : '');
			const codec = f.metadata?.codec_name;
			const reso = f.metadata?.width && f.metadata?.height ? `${f.metadata.width}×${f.metadata.height}` : '';
			const extras = [codec && `codec: ${codec}`, reso && `res: ${reso}`].filter(Boolean).join(', ');
			li.innerHTML = f.downloadUrl
				? `<a href="${escapeAttr(f.downloadUrl)}" target="_blank" rel="noopener" title="Download ${escapeHtml(name)}">Download</a> (${escapeHtml(size)}) ${extras ? `<span class="meta">(${escapeHtml(extras)})</span>` : ''}`
				: `${escapeHtml(name)} ${size ? '— '+escapeHtml(size): ''} ${extras ? `<span class="meta">(${escapeHtml(extras)})</span>` : ''}`;
			ul.appendChild(li);
		}
		div.appendChild(ul);
	}
	app.appendChild(div);
}

function escapeHtml(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escapeAttr(s){ return String(s).replace(/"/g,'&quot;'); }
