import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'

const C = 339.292
const dayKey = (d = new Date()) => d.toLocaleDateString('en-CA')
const LS = { timers: 'st_timers', pending: 'st_pending' }
const read = (k, fallback) => {
  try {
    const v = localStorage.getItem(k)
    return v ? JSON.parse(v) : fallback
  } catch {
    return fallback
  }
}
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {}
}

const fmt = (sec) => {
  sec = Math.ceil(sec)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const p = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}
const fmtTotal = (sec) => {
  const m = Math.floor(sec / 60)
  const h = Math.floor(m / 60)
  return h ? `${h}س ${m % 60}د` : `${m}د`
}
const label = (t) => (t.run ? 'وقّف' : t.done ? 'ابدأ من جديد' : t.rem < t.total ? 'كمّل' : 'ابدأ')

const PRESETS = [
  { n: 'تركيز', m: 25, t: 'focus' },
  { n: 'تركيز', m: 50, t: 'focus' },
  { n: 'مراجعة', m: 90, t: 'focus' },
  { n: 'استراحة', m: 5, t: 'rest' },
  { n: 'استراحة', m: 15, t: 'rest' },
]

export default function App() {
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (session === undefined) return null
  if (!session) return <Auth />
  return <Timers user={session.user} />
}

function Auth() {
  const [mode, setMode] = useState('in')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState({ text: '', ok: false })
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setMsg({ text: '', ok: false })
    const { data, error } =
      mode === 'in'
        ? await supabase.auth.signInWithPassword({ email, password: pw })
        : await supabase.auth.signUp({ email, password: pw })
    setBusy(false)
    if (error) {
      setMsg({ text: error.message.includes('Invalid login') ? 'الإيميل أو كلمة السر غلط' : error.message, ok: false })
    } else if (mode === 'up' && !data.session) {
      setMsg({ text: 'وصلتك رسالة تأكيد على الإيميل. اضغط الرابط وبعدها سجّل دخول.', ok: true })
    }
  }

  return (
    <div className="auth">
      <h1>مؤقتات الدراسة</h1>
      <p>سجّل دخول حتى يتزامن سجل دراستك بين أجهزتك.</p>
      <form onSubmit={submit}>
        <input type="email" required placeholder="الإيميل" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" autoComplete="email" />
        <input type="password" required minLength={6} placeholder="كلمة السر (6 أحرف أو أكثر)" value={pw} onChange={(e) => setPw(e.target.value)} dir="ltr" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />
        <button className="add" disabled={busy}>{mode === 'in' ? 'دخول' : 'سوّي حساب'}</button>
        {msg.text && <div className={`msg ${msg.ok ? 'ok' : ''}`}>{msg.text}</div>}
        <button type="button" className="link" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
          {mode === 'in' ? 'ماعندي حساب' : 'عندي حساب'}
        </button>
      </form>
    </div>
  )
}

function Timers({ user }) {
  const ref = useRef(read(LS.timers, []))
  const pendRef = useRef(read(LS.pending, []))
  const audio = useRef(null)
  const syncing = useRef(false)
  const toastTimer = useRef(null)
  const [, bump] = useState(0)
  const [toast, setToast] = useState('')
  const [dbDays, setDbDays] = useState({})
  const [form, setForm] = useState({ name: '', min: 30, kind: 'focus' })

  const rerender = () => bump((n) => n + 1)
  const persist = () => write(LS.timers, ref.current)

  const say = (msg) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 5000)
  }

  const loadDays = useCallback(async () => {
    const from = new Date()
    from.setDate(from.getDate() - 6)
    const { data } = await supabase.from('study_daily').select('day,focus_seconds').gte('day', dayKey(from))
    const m = {}
    ;(data || []).forEach((r) => (m[r.day] = r.focus_seconds || 0))
    setDbDays(m)
  }, [])

  const sync = useCallback(async () => {
    if (syncing.current) return
    const p = pendRef.current.slice()
    if (!p.length) {
      loadDays()
      return
    }
    syncing.current = true
    const { error } = await supabase.from('study_sessions').insert(p)
    syncing.current = false
    if (!error) {
      pendRef.current = pendRef.current.slice(p.length)
      write(LS.pending, pendRef.current)
    }
    loadDays()
  }, [loadDays])

  const queue = (t) => {
    if ((t.acc || 0) >= 5) {
      pendRef.current.push({ label: t.name, kind: t.type, seconds: Math.round(t.acc), day: dayKey() })
      write(LS.pending, pendRef.current)
      t.acc = 0
      sync()
    }
  }

  const beep = () => {
    try {
      const ctx = audio.current
      if (ctx) {
        ;[0, 0.35, 0.7].forEach((d) => {
          const o = ctx.createOscillator()
          const g = ctx.createGain()
          o.frequency.value = 880
          o.connect(g)
          g.connect(ctx.destination)
          const t0 = ctx.currentTime + d
          g.gain.setValueAtTime(0.0001, t0)
          g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02)
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3)
          o.start(t0)
          o.stop(t0 + 0.32)
        })
      }
    } catch {}
    try {
      navigator.vibrate && navigator.vibrate([200, 100, 200])
    } catch {}
  }

  const unlock = () => {
    try {
      audio.current = audio.current || new (window.AudioContext || window.webkitAudioContext)()
      audio.current.resume && audio.current.resume()
    } catch {}
    try {
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
    } catch {}
  }

  const start = (t) => {
    if (t.done) {
      t.rem = t.total
      t.done = false
    }
    t.run = true
    t.end = Date.now() + t.rem * 1000
  }

  const finish = (t) => {
    t.run = false
    t.done = true
    t.rem = 0
    queue(t)
    const list = ref.current
    const nx = list[list.indexOf(t) + 1]
    if (t.g && nx && nx.g === t.g && !nx.done) start(nx)
    const msg = t.type === 'focus' ? `خلص «${t.name}». وقت استراحة` : `خلصت «${t.name}». ارجع للدراسة`
    beep()
    say(msg)
    try {
      if ('Notification' in window && Notification.permission === 'granted') new Notification('مؤقتات الدراسة', { body: msg })
    } catch {}
  }

  const tick = useCallback(() => {
    const now = Date.now()
    ref.current.forEach((t) => {
      if (!t.run) return
      const nr = Math.max(0, (t.end - now) / 1000)
      t.acc = (t.acc || 0) + Math.max(0, t.rem - nr)
      t.rem = nr
      if (nr === 0) finish(t)
    })
    persist()
    rerender()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    tick()
    sync()
    const a = setInterval(tick, 250)
    const b = setInterval(() => {
      ref.current.forEach((t) => t.run && queue(t))
    }, 60000)
    const v = () => tick()
    document.addEventListener('visibilitychange', v)
    return () => {
      clearInterval(a)
      clearInterval(b)
      document.removeEventListener('visibilitychange', v)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const timers = ref.current
  const running = timers.find((t) => t.run)
  useEffect(() => {
    document.title = running ? `${fmt(running.rem)} · ${running.name}` : 'مؤقتات الدراسة'
  })

  const act = (id, a) => {
    const list = ref.current
    const t = list.find((x) => x.id === id)
    if (!t) return
    if (a === 'toggle') {
      if (t.run) {
        tick()
        t.run = false
        queue(t)
      } else {
        start(t)
        unlock()
      }
    } else if (a === 'reset') {
      queue(t)
      t.run = false
      t.done = false
      t.rem = t.total
    } else if (a === 'plus') {
      t.total += 300
      t.rem += 300
      if (t.run) t.end += 300000
      t.done = false
    } else if (a === 'del') {
      queue(t)
      ref.current = list.filter((x) => x.id !== id)
    }
    persist()
    rerender()
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  const add = (name, min, type) => {
    min = Math.max(1, Math.min(600, Math.round(+min || 0)))
    ref.current.push({ id: uid(), name: name || (type === 'focus' ? 'تركيز' : 'استراحة'), type, total: min * 60, rem: min * 60, run: false, done: false, acc: 0 })
    persist()
    rerender()
  }
  const cycle = () => {
    const g = 'g' + uid()
    const made = []
    for (let n = 1; n <= 4; n++) {
      made.push({ id: uid(), g, name: `تركيز ${n}/4`, type: 'focus', total: 1500, rem: 1500, run: false, done: false, acc: 0 })
      made.push({ id: uid(), g, name: n < 4 ? 'استراحة قصيرة' : 'استراحة طويلة', type: 'rest', total: n < 4 ? 300 : 900, rem: n < 4 ? 300 : 900, run: false, done: false, acc: 0 })
    }
    ref.current.push(...made)
    start(made[0])
    unlock()
    persist()
    rerender()
  }

  // weekly chart: saved sessions + not-yet-synced + live seconds today
  const days = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    days.push({ k: dayKey(d), n: d.toLocaleDateString('ar', { weekday: 'short' }), today: i === 0 })
  }
  const secs = {}
  days.forEach((d) => (secs[d.k] = dbDays[d.k] || 0))
  pendRef.current.forEach((p) => {
    if (p.kind === 'focus' && p.day in secs) secs[p.day] += p.seconds
  })
  timers.forEach((t) => {
    if (t.type === 'focus') secs[dayKey()] += t.acc || 0
  })
  const mins = days.map((d) => Math.floor(secs[d.k] / 60))
  const mx = Math.max(60, ...mins)
  const weekTotal = mins.reduce((a, b) => a + b, 0)
  const todayMins = mins[6]

  return (
    <main>
      <header>
        <h1>مؤقتات الدراسة</h1>
        <div className="total">
          ركّزت اليوم: <b>{fmtTotal(todayMins * 60)}</b>
        </div>
        <div className="who">
          <span dir="ltr">{user.email}</span>
          <button className="link" onClick={() => supabase.auth.signOut()}>خروج</button>
        </div>
      </header>

      <section className="panel">
        <h2>مؤقت جاهز</h2>
        <div className="chips">
          {PRESETS.map((p) => (
            <button key={p.n + p.m} className={`chip ${p.t === 'focus' ? 'f' : 'r'}`} onClick={() => add(p.n, p.m, p.t)}>
              {p.n} {p.m} د
            </button>
          ))}
          <button className="chip cyc" onClick={cycle}>دورة بومودورو كاملة (4 جولات)</button>
        </div>
        <h2>أو سوّي مؤقت خاص بيك</h2>
        <div className="custom">
          <input
            placeholder="الاسم، مثلاً: حديثي الولادة"
            maxLength={40}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                add(form.name.trim(), form.min, form.kind)
                setForm({ ...form, name: '' })
              }
            }}
            aria-label="اسم المؤقت"
          />
          <input type="number" min="1" max="600" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} aria-label="الدقائق" />
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label="النوع">
            <option value="focus">تركيز</option>
            <option value="rest">استراحة</option>
          </select>
          <button
            className="add"
            onClick={() => {
              add(form.name.trim(), form.min, form.kind)
              setForm({ ...form, name: '' })
            }}
          >
            أضف
          </button>
        </div>
      </section>

      <section className="list" aria-label="المؤقتات">
        {timers.length === 0 && <div className="empty">ماكو مؤقتات بعد. اختار واحد جاهز من فوق.</div>}
        {timers.map((t) => (
          <article key={t.id} className={`card ${t.type} ${t.run ? 'running' : ''} ${t.done ? 'done' : ''}`}>
            <div className="top">
              <span className="name">
                {t.name}
                {t.g && <span className="gtag"> · دورة</span>}
              </span>
              <button className="x" onClick={() => act(t.id, 'del')} aria-label="احذف المؤقت">✕</button>
            </div>
            <div className="ring">
              <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle className="tr" cx="60" cy="60" r="54" />
                <circle className="pr" cx="60" cy="60" r="54" style={{ strokeDashoffset: C * (1 - t.rem / t.total) }} />
              </svg>
              <div className="time">{fmt(t.rem)}</div>
            </div>
            <div className="btns">
              <button className="main" onClick={() => act(t.id, 'toggle')}>{label(t)}</button>
              <button onClick={() => act(t.id, 'reset')}>صفّر</button>
              <button onClick={() => act(t.id, 'plus')}>+5 د</button>
            </div>
          </article>
        ))}
      </section>

      <section className="panel" style={{ marginTop: 20 }} aria-label="آخر 7 أيام">
        <h2>
          تركيزك آخر 7 أيام: <b style={{ color: 'var(--ink)' }}>{fmtTotal(weekTotal * 60)}</b>
        </h2>
        <div className="week">
          {days.map((d, i) => (
            <div key={d.k} className={`day ${d.today ? 'now' : ''}`}>
              <small>{mins[i]}د</small>
              <div className="bar" style={{ height: Math.round((mins[i] / mx) * 80) }} />
              <small>{d.n}</small>
            </div>
          ))}
        </div>
      </section>

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  )
}
