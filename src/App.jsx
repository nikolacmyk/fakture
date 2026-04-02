import { useState, useEffect, useRef, useCallback } from 'react'
import { db } from './lib/firebase'
import { collection, addDoc, getDocs, deleteDoc, doc, query, orderBy } from 'firebase/firestore'
import { parseInvoiceText } from './lib/pdfParser'

const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.min.mjs'
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.worker.min.mjs'

const MJESECI = ['Januar','Februar','Mart','April','Maj','Juni','Juli','August',
                 'Septembar','Oktobar','Novembar','Decembar']

function fmt(n) {
  if (n == null || n === '') return '—'
  return Number(n).toLocaleString('bs-BA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function nowMonthIndex() {
  const d = new Date()
  return d.getFullYear() * 12 + d.getMonth()
}
function decodeMonthIndex(idx) {
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 }
}

let pdfjsLib = null
async function getPdfJs() {
  if (pdfjsLib) return pdfjsLib
  const mod = await import(/* @vite-ignore */ PDFJS_URL)
  mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER
  pdfjsLib = mod
  return pdfjsLib
}

async function extractTextFromPdf(arrayBuffer) {
  const pdfjs = await getPdfJs()
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise
  let fullText = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    fullText += content.items.map(item => item.str).join(' ') + '\n'
  }
  return fullText
}

function useToast() {
  const [toast, setToast] = useState(null)
  const show = useCallback((msg, type = '') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3200)
  }, [])
  return { toast, show }
}

export default function App() {
  const [tipo, setTipo]           = useState('ulaz')
  const [modo, setModo]           = useState('pdf')
  const [file, setFile]           = useState(null)
  const [aiState, setAiState]     = useState('idle')
  const [aiLog, setAiLog]         = useState([])
  const [form, setForm]           = useState({ datum: '', neto: '', pdv: '', ukupno: '', firma: '' })
  const [extracted, setExtracted] = useState({})
  const [fakture, setFakture]     = useState([])
  const [monthIdx, setMonthIdx]   = useState(nowMonthIndex)
  const [saving, setSaving]       = useState(false)
  const [loading, setLoading]     = useState(true)
  const { toast, show: showToast } = useToast()
  const fileInputRef = useRef()

  useEffect(() => { loadFakture() }, [])

  async function loadFakture() {
    setLoading(true)
    try {
      const q = query(collection(db, 'fakture'), orderBy('datum', 'desc'))
      const snap = await getDocs(q)
      setFakture(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    } catch (e) {
      showToast('Greška učitavanja: ' + e.message, 'error')
    }
    setLoading(false)
  }

  function switchModo(m) {
    setModo(m)
    setFile(null); setAiState('idle'); setAiLog([])
    setForm({ datum: '', neto: '', pdv: '', ukupno: '', firma: '' })
    setExtracted({})
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleDrop(e) {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (f) handlePdf(f)
  }
  function handleFileInput(e) {
    const f = e.target.files[0]
    if (f) handlePdf(f)
  }

  function handlePdf(f) {
    if (f.type !== 'application/pdf') {
      showToast('Samo PDF — za ostalo koristi Ručni unos', 'error'); return
    }
    setFile(f); setAiState('loading'); setAiLog([])
    setForm({ datum: '', neto: '', pdv: '', ukupno: '', firma: '' }); setExtracted({})
    const reader = new FileReader()
    reader.onload = ev => processPdf(ev.target.result)
    reader.readAsArrayBuffer(f)
  }

  async function processPdf(arrayBuffer) {
    try {
      const rawText = await extractTextFromPdf(arrayBuffer)
      const parsed  = parseInvoiceText(rawText)
      const log = []
      const newForm = { datum: '', neto: '', pdv: '', ukupno: '', firma: '' }
      const newExtracted = {}

      const set = (key, val, label) => {
        if (val != null) {
          newForm[key] = key === 'datum' ? val : String(Number(val).toFixed(2))
          newExtracted[key] = true
          log.push({ ok: true, text: `${label}: ${newForm[key]}` })
        } else {
          log.push({ ok: false, text: `${label}: nije pronađen — unesi ručno` })
        }
      }

      set('datum',  parsed.datum,  'Datum')
      set('neto',   parsed.neto,   'Neto')
      set('pdv',    parsed.pdv,    'PDV')
      set('ukupno', parsed.ukupno, 'Ukupno')
      if (parsed.firma) {
        newForm.firma = parsed.firma; newExtracted.firma = true
        log.push({ ok: true, text: `Firma: ${parsed.firma}` })
      }

      setForm(newForm); setExtracted(newExtracted); setAiLog(log)
      setAiState('done')
    } catch (err) {
      console.error(err)
      setAiLog([{ ok: false, text: 'Greška: ' + err.message }])
      setAiState('error')
    }
  }

  async function saveFaktura() {
    if (!form.datum) { showToast('Datum je obavezan!', 'error'); return }
    if (!form.neto && !form.pdv && !form.ukupno) { showToast('Unesi bar jedan iznos!', 'error'); return }
    setSaving(true)
    const parts = form.datum.split('-').map(Number)
    try {
      await addDoc(collection(db, 'fakture'), {
        tip: tipo, datum: form.datum,
        godina: parts[0], mjesec: parts[1],
        neto:   parseFloat(form.neto)   || 0,
        pdv:    parseFloat(form.pdv)    || 0,
        ukupno: parseFloat(form.ukupno) || 0,
        firma:  form.firma || '',
        fileName: file?.name || '',
        createdAt: new Date().toISOString(),
      })
      showToast('Faktura sačuvana ✓', 'success')
      setForm({ datum: '', neto: '', pdv: '', ukupno: '', firma: '' }); setExtracted({})
      setFile(null); setAiState('idle'); setAiLog([])
      if (fileInputRef.current) fileInputRef.current.value = ''
      await loadFakture()
    } catch (e) { showToast('Greška: ' + e.message, 'error') }
    setSaving(false)
  }

  async function deleteFaktura(id) {
    if (!confirm('Obrisati ovu fakturu?')) return
    try {
      await deleteDoc(doc(db, 'fakture', id))
      showToast('Obrisano', 'success')
      setFakture(prev => prev.filter(f => f.id !== id))
    } catch (e) { showToast('Greška: ' + e.message, 'error') }
  }

  const { year: selYear, month: selMonth } = decodeMonthIndex(monthIdx)
  const allUlaz  = fakture.filter(f => f.tip === 'ulaz')
  const allIzlaz = fakture.filter(f => f.tip === 'izlaz')
  const totUPdv  = allUlaz.reduce( (s, f) => s + (f.pdv || 0), 0)
  const totIPdv  = allIzlaz.reduce((s, f) => s + (f.pdv || 0), 0)
  const monthFakture = fakture.filter(f => f.godina === selYear && f.mjesec === selMonth)
  const mUlaz  = monthFakture.filter(f => f.tip === 'ulaz')
  const mIzlaz = monthFakture.filter(f => f.tip === 'izlaz')
  const mUNeto = mUlaz.reduce( (s,f) => s+(f.neto||0), 0)
  const mUPdv  = mUlaz.reduce( (s,f) => s+(f.pdv ||0), 0)
  const mINeto = mIzlaz.reduce((s,f) => s+(f.neto||0), 0)
  const mIPdv  = mIzlaz.reduce((s,f) => s+(f.pdv ||0), 0)
  const mRazl  = mIPdv - mUPdv

  const showForm = modo === 'rucno' || aiState === 'done' || aiState === 'error'

  return (
    <div style={{ display:'flex', flexDirection:'column', minHeight:'100vh' }}>

      <header style={s.header}>
        <div style={s.logo}>TexPrint <span style={{color:'var(--muted)',fontWeight:400}}>/ PDV Tracker</span></div>
        <div style={s.fbBadge}><div style={{width:6,height:6,borderRadius:'50%',background:'var(--green)'}}/> Firestore</div>
      </header>

      <div style={s.app}>

        {/* LEFT */}
        <div style={s.panelLeft}>

          <div>
            <div style={s.sectionTitle}>Tip fakture</div>
            <div style={s.toggle}>
              <button style={{...s.toggleBtn,...(tipo==='ulaz'?s.activeUlaz:{})}} onClick={()=>setTipo('ulaz')}>▲ Ulazna</button>
              <button style={{...s.toggleBtn,...(tipo==='izlaz'?s.activeIzlaz:{})}} onClick={()=>setTipo('izlaz')}>▼ Izlazna</button>
            </div>
          </div>

          <div>
            <div style={s.sectionTitle}>Način unosa</div>
            <div style={s.toggle}>
              <button style={{...s.toggleBtn,fontSize:11,...(modo==='pdf'?s.activeUlaz:{})}} onClick={()=>switchModo('pdf')}>📄 PDF faktura</button>
              <button style={{...s.toggleBtn,fontSize:11,...(modo==='rucno'?s.activeUlaz:{})}} onClick={()=>switchModo('rucno')}>✏️ Ručni unos</button>
            </div>
          </div>

          {modo==='pdf' && (
            <div>
              <div style={s.sectionTitle}>Učitaj PDF</div>
              {!file ? (
                <div style={s.dropZone}
                  onClick={()=>fileInputRef.current?.click()}
                  onDragOver={e=>e.preventDefault()}
                  onDrop={handleDrop}>
                  <input ref={fileInputRef} type="file" accept=".pdf" style={{display:'none'}} onChange={handleFileInput}/>
                  <div style={{fontSize:28,marginBottom:10,opacity:0.6}}>📄</div>
                  <div style={{color:'var(--text2)',lineHeight:1.5,fontSize:13}}>
                    Prevuci ovdje ili <span style={{color:'var(--accent)'}}>klikni</span>
                  </div>
                  <div style={{fontFamily:'var(--mono)',fontSize:10,color:'var(--muted)',marginTop:6}}>Samo PDF · čita se lokalno, bez API keya</div>
                </div>
              ) : (
                <div style={s.filePreview}>
                  <span style={s.fileName}>{file.name}</span>
                  <button style={s.clearBtn} onClick={()=>{setFile(null);setAiState('idle');setAiLog([]);if(fileInputRef.current)fileInputRef.current.value=''}}>✕</button>
                </div>
              )}
            </div>
          )}

          {aiState==='loading' && (
            <div style={s.aiLoading}><div style={s.spinner}/>Čitam PDF...</div>
          )}

          {aiLog.length>0 && (
            <div style={s.aiLog}>
              {aiLog.map((l,i)=>(
                <div key={i} style={{display:'flex',gap:7}}>
                  <span style={{color:l.ok?'var(--green)':'var(--muted)',flexShrink:0}}>{l.ok?'✓':'·'}</span>
                  <span style={{color:l.ok?'var(--text2)':'var(--muted)'}}>{l.text}</span>
                </div>
              ))}
            </div>
          )}

          {showForm && (
            <div style={s.formBox}>
              <div style={s.formHeader}>
                <span>{modo==='rucno'?'Ručni unos':'Podaci sa fakture'}</span>
                {modo==='pdf' && <span style={s.badge2}>PDF.js parser</span>}
              </div>
              <div style={s.formFields}>
                {[
                  {id:'datum', label:'Datum isporuke / fakture',     type:'date'},
                  {id:'neto',  label:'Neto iznos / Osnovica (KM)',    type:'number'},
                  {id:'pdv',   label:'Iznos PDV-a (KM)',              type:'number'},
                  {id:'ukupno',label:'Za uplatu / Ukupno s PDV (KM)', type:'number'},
                  {id:'firma', label:'Naziv firme / dobavljača',      type:'text'},
                ].map(({id,label,type})=>(
                  <div key={id} style={{display:'flex',flexDirection:'column',gap:4}}>
                    <label style={s.fieldLabel}>{label}</label>
                    <input type={type} step={type==='number'?'0.01':undefined}
                      placeholder={type==='number'?'0.00':type==='text'?'Opciono':undefined}
                      value={form[id]}
                      onChange={e=>setForm(p=>({...p,[id]:e.target.value}))}
                      style={{...s.fieldInput,...(extracted[id]?s.fieldExtracted:{})}}/>
                  </div>
                ))}
                <button onClick={saveFaktura} disabled={saving}
                  style={{...s.btnSave,opacity:saving?.6:1,cursor:saving?'not-allowed':'pointer'}}>
                  {saving?'Čuvam...':'Sačuvaj fakturu'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT */}
        <div style={s.panelRight}>

          <div>
            <div style={{...s.sectionTitle,marginBottom:12}}>Sveukupno — svi periodi</div>
            <div style={s.summaryGrid}>
              <SummaryCard label="Ukupno ulaz (PDV)"       value={fmt(totUPdv)+' KM'} sub={allUlaz.length+' faktura'}  color="var(--green)"/>
              <SummaryCard label="Ukupno izlaz (PDV)"      value={fmt(totIPdv)+' KM'} sub={allIzlaz.length+' faktura'} color="var(--red)"/>
              <SummaryCard label="PDV razlika (za uplatu)" value={fmt(totIPdv-totUPdv)+' KM'} sub="Izlaz − Ulaz"      color="var(--accent)"/>
            </div>
          </div>

          <div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
              <div style={s.sectionTitle}>Pregled po mjesecu</div>
              <div style={{display:'flex',alignItems:'center',gap:12}}>
                <button style={s.monthBtn} onClick={()=>setMonthIdx(i=>i-1)}>‹</button>
                <div style={s.monthDisplay}>{MJESECI[selMonth-1]} {selYear}</div>
                <button style={s.monthBtn} onClick={()=>setMonthIdx(i=>i+1)}>›</button>
              </div>
            </div>
            <div style={s.statsGrid}>
              <StatBox label="Ulaz neto"  value={fmt(mUNeto)} color="var(--green)"/>
              <StatBox label="Ulaz PDV"   value={fmt(mUPdv)}  color="var(--green)"/>
              <StatBox label="Izlaz neto" value={fmt(mINeto)} color="var(--red)"/>
              <StatBox label="Izlaz PDV"  value={fmt(mIPdv)}  color="var(--red)"/>
            </div>
            <div style={{marginTop:10}}>
              <StatBox label="PDV za uplatiti ovaj mjesec"
                value={fmt(mRazl)+' KM'}
                color={mRazl>0?'var(--red)':mRazl<0?'var(--green)':'var(--accent)'}
                wide/>
            </div>
          </div>

          <div style={s.tableWrap}>
            <div style={s.tableHead}>
              <div style={{...s.sectionTitle,margin:0}}>Fakture — {MJESECI[selMonth-1]} {selYear}</div>
              <span style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--muted)'}}>{monthFakture.length} stavki</span>
            </div>
            {loading ? (
              <div style={s.emptyState}>Učitavanje...</div>
            ) : monthFakture.length===0 ? (
              <div style={s.emptyState}>Nema faktura za ovaj period.</div>
            ) : (
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead><tr>{['Datum','Tip','Firma','Neto KM','PDV KM','Ukupno KM',''].map(h=><th key={h} style={s.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {monthFakture.map(f=>(
                      <tr key={f.id}>
                        <td style={s.td}>{f.datum}</td>
                        <td style={s.td}><span style={{...s.tipBadge,...(f.tip==='ulaz'?s.tipUlaz:s.tipIzlaz)}}>{f.tip==='ulaz'?'▲ Ulaz':'▼ Izlaz'}</span></td>
                        <td style={{...s.td,maxWidth:140,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{f.firma||'—'}</td>
                        <td style={s.td}>{fmt(f.neto)}</td>
                        <td style={{...s.td,color:f.tip==='ulaz'?'var(--green)':'var(--red)'}}>{fmt(f.pdv)}</td>
                        <td style={s.td}>{fmt(f.ukupno)}</td>
                        <td style={s.td}><button style={s.btnDel} onClick={()=>deleteFaktura(f.id)}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {toast && (
        <div style={{...s.toast,...(toast.type==='success'?s.toastSuccess:s.toastError)}}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}

function SummaryCard({label,value,sub,color}) {
  return <div style={s.summaryCard}><div style={s.summaryLabel}>{label}</div><div style={{...s.summaryValue,color}}>{value}</div><div style={s.summarySub}>{sub}</div></div>
}
function StatBox({label,value,color,wide}) {
  return <div style={{...s.statBox,...(wide?{display:'inline-block',minWidth:220}:{})}}><div style={s.statLabel}>{label}</div><div style={{...s.statValue,color}}>{value}</div></div>
}

const s = {
  header:{borderBottom:'1px solid var(--border)',padding:'18px 32px',display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:0,background:'var(--bg)',zIndex:100},
  logo:{fontFamily:'var(--mono)',fontSize:13,fontWeight:600,letterSpacing:'0.08em',color:'var(--accent)',textTransform:'uppercase'},
  fbBadge:{fontFamily:'var(--mono)',fontSize:11,padding:'4px 10px',borderRadius:2,background:'#0f2119',border:'1px solid #1a3a27',color:'var(--green)',display:'flex',alignItems:'center',gap:6},
  app:{display:'grid',gridTemplateColumns:'400px 1fr',minHeight:'calc(100vh - 57px)'},
  panelLeft:{borderRight:'1px solid var(--border)',padding:'24px 20px',display:'flex',flexDirection:'column',gap:18,overflowY:'auto'},
  panelRight:{padding:'28px 32px',display:'flex',flexDirection:'column',gap:28,overflowY:'auto'},
  sectionTitle:{fontFamily:'var(--mono)',fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',color:'var(--muted)',marginBottom:4},
  toggle:{display:'grid',gridTemplateColumns:'1fr 1fr',border:'1px solid var(--border)',borderRadius:4,overflow:'hidden'},
  toggleBtn:{padding:'10px',background:'transparent',border:'none',cursor:'pointer',fontFamily:'var(--mono)',fontSize:12,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted)',textTransform:'uppercase'},
  activeUlaz:{background:'#0f2119',color:'var(--green)'},
  activeIzlaz:{background:'#210f0f',color:'var(--red)'},
  dropZone:{border:'1.5px dashed var(--border2)',borderRadius:6,padding:'32px 20px',textAlign:'center',cursor:'pointer',background:'var(--surface)'},
  filePreview:{background:'var(--surface2)',border:'1px solid var(--border2)',borderRadius:4,padding:'10px 12px',display:'flex',alignItems:'center',justifyContent:'space-between',gap:10},
  fileName:{fontFamily:'var(--mono)',fontSize:11,color:'var(--text2)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'},
  clearBtn:{background:'none',border:'none',color:'var(--muted)',cursor:'pointer',fontSize:16,flexShrink:0},
  aiLoading:{display:'flex',alignItems:'center',gap:10,color:'var(--accent)',fontFamily:'var(--mono)',fontSize:12},
  spinner:{width:16,height:16,border:'2px solid #3a3510',borderTopColor:'var(--accent)',borderRadius:'50%',animation:'spin 0.8s linear infinite',flexShrink:0},
  aiLog:{fontFamily:'var(--mono)',fontSize:11,color:'var(--muted)',lineHeight:1.9,display:'flex',flexDirection:'column'},
  formBox:{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,overflow:'hidden'},
  formHeader:{padding:'10px 14px',background:'var(--surface2)',borderBottom:'1px solid var(--border)',fontFamily:'var(--mono)',fontSize:10,letterSpacing:'0.1em',textTransform:'uppercase',color:'var(--muted)',display:'flex',alignItems:'center',justifyContent:'space-between'},
  badge2:{background:'#0e0e1a',border:'1px solid #2a2a4a',color:'#7a9ef8',padding:'2px 7px',borderRadius:2,fontSize:10},
  formFields:{padding:'14px',display:'flex',flexDirection:'column',gap:11},
  fieldLabel:{fontFamily:'var(--mono)',fontSize:10,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--muted)'},
  fieldInput:{background:'var(--bg)',border:'1px solid var(--border2)',borderRadius:3,padding:'8px 10px',color:'var(--text)',fontFamily:'var(--mono)',fontSize:13,width:'100%',outline:'none'},
  fieldExtracted:{borderColor:'#2a3a1a',background:'#0d110a',color:'var(--green)'},
  btnSave:{width:'100%',padding:12,background:'var(--accent)',color:'#0e0f11',border:'none',borderRadius:4,fontFamily:'var(--mono)',fontSize:12,fontWeight:600,letterSpacing:'0.08em',textTransform:'uppercase'},
  summaryGrid:{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12},
  summaryCard:{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,padding:'14px 16px'},
  summaryLabel:{fontFamily:'var(--mono)',fontSize:10,letterSpacing:'0.1em',textTransform:'uppercase',color:'var(--muted)',marginBottom:6},
  summaryValue:{fontFamily:'var(--mono)',fontSize:20,fontWeight:600,lineHeight:1},
  summarySub:{fontFamily:'var(--mono)',fontSize:10,color:'var(--muted)',marginTop:4},
  statsGrid:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10},
  statBox:{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:4,padding:'12px 14px'},
  statLabel:{fontFamily:'var(--mono)',fontSize:9,letterSpacing:'0.1em',textTransform:'uppercase',color:'var(--muted)',marginBottom:5},
  statValue:{fontFamily:'var(--mono)',fontSize:16,fontWeight:600},
  monthBtn:{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:3,color:'var(--text2)',width:28,height:28,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',fontSize:14},
  monthDisplay:{fontFamily:'var(--mono)',fontSize:13,fontWeight:600,minWidth:130,textAlign:'center'},
  tableWrap:{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,overflow:'hidden'},
  tableHead:{padding:'10px 16px',background:'var(--surface2)',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between'},
  th:{padding:'9px 12px',textAlign:'left',fontFamily:'var(--mono)',fontSize:9,letterSpacing:'0.12em',textTransform:'uppercase',color:'var(--muted)',borderBottom:'1px solid var(--border)',background:'var(--surface2)'},
  td:{padding:'9px 12px',fontFamily:'var(--mono)',fontSize:12,color:'var(--text2)',borderBottom:'1px solid var(--border)'},
  tipBadge:{display:'inline-flex',alignItems:'center',padding:'2px 7px',borderRadius:2,fontFamily:'var(--mono)',fontSize:10,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase'},
  tipUlaz:{background:'#0f2119',color:'var(--green)',border:'1px solid #1a3a27'},
  tipIzlaz:{background:'#210f0f',color:'var(--red)',border:'1px solid #3a1a1a'},
  btnDel:{background:'none',border:'1px solid transparent',borderRadius:3,color:'var(--muted)',cursor:'pointer',padding:'2px 6px',fontSize:11},
  emptyState:{padding:40,textAlign:'center',color:'var(--muted)',fontFamily:'var(--mono)',fontSize:12,lineHeight:2},
  toast:{position:'fixed',bottom:24,right:24,background:'var(--surface2)',border:'1px solid var(--border2)',borderRadius:4,padding:'12px 16px',fontFamily:'var(--mono)',fontSize:12,color:'var(--text)',zIndex:999,maxWidth:320,animation:'fadeUp 0.3s ease'},
  toastSuccess:{borderColor:'#1a3a27',color:'var(--green)',background:'#0a1810'},
  toastError:{borderColor:'#3a1a1a',color:'var(--red)',background:'#180a0a'},
}
