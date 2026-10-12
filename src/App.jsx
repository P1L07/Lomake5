import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from './supabaseClient'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import './App.css'
import Tesseract from 'tesseract.js'
import * as pdfjsLib from 'pdfjs-dist'
pdfjsLib.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`

const DEFAULT_SETTINGS = {
  company_name: '',
  company_address: '',
  company_phone: '',
  company_email: '',
  company_iban: '',
  company_swift: '',
  company_vat: '',
  business_id: '',
  default_tax_rate: '25.5',
  invoice_prefix: 'INV',
  next_invoice_number: '1',
  delay_tax_rate: '11.00',
  vat_reporting_period: 'monthly',
}

// Yksittäinen laskurivi
const DEFAULT_INVOICE_LINE = {
  description: '',
  quantity: '1',
  unit_price: '0.00',
  tax_rate: '25.5',
}

const DEFAULT_INVOICE_DATA = {
  buyer_name: '',
  buyer_address: '',
  buyer_email: '',
  invoice_number: '1',
  reference_number: '',
  project_details: '',
  expense_reference: '',   // <- uusi
  lines: [{ ...DEFAULT_INVOICE_LINE }],
  date_issued: new Date().toISOString().split('T')[0],
  income_category: '3001',
  selectedCustomerId: '',
}

const INCOME_TAX_RATES = {
  3001: 25.5,
  3002: 14,
  3003: 10,
  3004: 0,
  3005: 0,
  3006: 0,
  3007: 0,
  3008: 13.5,
  3010: 0,
  3011: 0,
  3100: 0,
  3901: 0,
  3903: 0,
}

const MONTH_LABELS = ['Tammi', 'Helmi', 'Maalis', 'Huhti', 'Touko', 'Kesä', 'Heinä', 'Elo', 'Syys', 'Loka', 'Marras', 'Joulu']

// ===== CSV-tuonnin apufunktiot =====

// Jäsennä yksi CSV-rivi (tukee lainausmerkkejä ja valittua erotinta)
function parseCsvLine(line, delimiter) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else current += ch
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === delimiter) { result.push(current); current = '' }
      else current += ch
    }
  }
  result.push(current)
  return result.map(s => s.trim())
}

// Tunnista erotinmerkki ensimmäiseltä riviltä
function detectDelimiter(line) {
  const candidates = [';', ',', '\t', '|']
  let best = ','
  let bestCount = 0
  for (const d of candidates) {
    const count = line.split(d).length
    if (count > bestCount) { bestCount = count; best = d }
  }
  return best
}

// Normalisoi otsikko vertailua varten (poistaa erikoismerkit)
function normalizeHeader(h) {
  return String(h || '').toLowerCase().trim().replace(/[^a-zä-öå0-9]/g, '')
}

// Tunnista sarakkeiden indeksit otsikkoriviltä
function detectColumns(headers) {
  const norm = headers.map(normalizeHeader)
  const find = (candidates) => {
    for (const c of candidates) {
      const i = norm.findIndex(h => h === c)
      if (i >= 0) return i
    }
    for (const c of candidates) {
      const i = norm.findIndex(h => h.includes(c))
      if (i >= 0) return i
    }
    return -1
  }
  return {
    date: find(['kirjauspäivä', 'tapahtumapäivä', 'maksupäivä', 'päivämäärä', 'date', 'bookingdate']),
    amount: find(['summa', 'määrä', 'amount', 'maksunmäärä']),
    name: find(['saajamaksaja', 'saaja', 'maksaja', 'nimi', 'name', 'recipient']),
    message: find(['viesti', 'selite', 'kuvaus', 'message', 'description']),
  }
}

// Jäsennä summa (tukee pilkkua/pistettä desimaalierottimena, €-symbolia, sulkuja)
function parseCsvAmount(str) {
  if (str == null) return NaN
  let s = String(str).trim()
  if (!s) return NaN
  s = s.replace(/[€$£\s\u00A0]/g, '')
  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1) }
  if (s.startsWith('-')) { negative = true; s = s.slice(1) }
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma > lastDot) {
    s = s.replace(/\./g, '').replace(',', '.')
  } else {
    s = s.replace(/,/g, '')
  }
  const num = parseFloat(s)
  if (isNaN(num)) return NaN
  return negative ? -num : num
}

// Jäsennä päivämäärä muotoon YYYY-MM-DD
function parseCsvDate(str) {
  if (!str) return null
  const s = String(str).trim()
  let m = s.match(/^(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{2,4})/)
  if (m) {
    let [, d, mo, y] = m
    if (y.length === 2) y = '20' + y
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  m = s.match(/^(\d{4})[\.\/\-](\d{1,2})[\.\/\-](\d{1,2})/)
  if (m) {
    const [, y, mo, d] = m
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return null
}

// Normalisoi nimi vertailua varten
function normalizeName(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.,]/g, '')
}

// Lue tiedosto tekstinä (UTF-8 ensin, fallback Latin-1)
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const buffer = reader.result
      let text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
      const bad = (text.match(/\uFFFD/g) || []).length
      if (bad > 3) text = new TextDecoder('iso-8859-1').decode(buffer)
      resolve(text)
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

// Vertaile CSV-rivejä sovelluksen tapahtumiin
function compareCsvToTransactions(csvRows, transactions) {
  const matchedIds = new Set()
  const results = csvRows.map(row => {
    // Pankin negatiivinen = meno, positiivinen = tulo
    const expectedType = row.amount < 0 ? 'expense' : 'income'
    const absAmount = Math.abs(row.amount)

    // 1) Tarkka osuma: päivä + summa + nimi
    let tx = transactions.find(t =>
      !matchedIds.has(t.id) &&
      t.date_issued === row.date &&
      t.type === expectedType &&
      Math.abs(parseFloat(t.amount_gross) - absAmount) < 0.01 &&
      normalizeName(t.contact_name) === normalizeName(row.name)
    )
    if (tx) { matchedIds.add(tx.id); return { type: 'exact', csv: row, tx } }

    // 2) Sama päivä + summa, eri nimi
    tx = transactions.find(t =>
      !matchedIds.has(t.id) &&
      t.date_issued === row.date &&
      t.type === expectedType &&
      Math.abs(parseFloat(t.amount_gross) - absAmount) < 0.01
    )
    if (tx) { matchedIds.add(tx.id); return { type: 'name_mismatch', csv: row, tx } }

    // 3) Sama päivä + nimi, eri summa
    tx = transactions.find(t =>
      !matchedIds.has(t.id) &&
      t.date_issued === row.date &&
      normalizeName(t.contact_name) === normalizeName(row.name)
    )
    if (tx) { matchedIds.add(tx.id); return { type: 'amount_mismatch', csv: row, tx } }

    // 4) Vain summa täsmää
    tx = transactions.find(t =>
      !matchedIds.has(t.id) &&
      Math.abs(parseFloat(t.amount_gross) - absAmount) < 0.01
    )
    if (tx) { matchedIds.add(tx.id); return { type: 'partial', csv: row, tx } }

    // 5) Ei osumaa
    return { type: 'missing', csv: row }
  })

  // Laske CSV:n aikaväli
  const dates = csvRows.map(r => r.date).filter(Boolean).sort()
  const minDate = dates[0]
  const maxDate = dates[dates.length - 1]
  // Vain ne sovelluksen tapahtumat, jotka osuvat CSV:n aikavälille
  // ja joita ei ole vielä yhdistetty CSV-riviin
  const bufferDays = 1 // salli ±1 päivä
  const minDateObj = new Date(minDate)
  minDateObj.setDate(minDateObj.getDate() - bufferDays)
  const maxDateObj = new Date(maxDate)
  maxDateObj.setDate(maxDateObj.getDate() + bufferDays)
  const minDateBuffered = minDateObj.toISOString().split('T')[0]
  const maxDateBuffered = maxDateObj.toISOString().split('T')[0]

  const unmatchedApp = transactions.filter(t =>
    !matchedIds.has(t.id) &&
    t.date_issued >= minDateBuffered &&
    t.date_issued <= maxDateBuffered
  )

  return { results, unmatchedApp, dateRange: { minDate, maxDate } }
}

function laskeTarkistusnumero(numeroString) {
  const digits = numeroString.replace(/\D/g, '').split('').reverse();
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    sum += parseInt(digits[i], 10) * weights[i % 3];
  }
  return ((10 - (sum % 10)) % 10).toString();
}


function generoiViitenumero(laskunNumero) {
  // Varmista, ettei etunolla tule: lisää eteen 1, jos numero on alle 100
  let pohja = String(laskunNumero);
  if (pohja.length < 3) {
    pohja = '1' + pohja; // esim. 35 -> 135
  }
  // Tarkistusnumero lasketaan oikealta vasemmalle painoilla 7,3,1
  const tarkiste = laskeTarkistusnumero(pohja);
  return pohja + tarkiste;
}



// Vero-välilehden kuvaaja: näyttää tulot, menot ja suurimmat kulut valitulla aikavälillä
function VeroVisuals({ transactions, categories, reportYear, effectivePeriod }) {
  const data = useMemo(() => {
    const year = parseInt(reportYear)
    let monthNums = []
    if (effectivePeriod === 'all') {
      monthNums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    } else if (effectivePeriod.startsWith('Q')) {
      const q = parseInt(effectivePeriod[1])
      const start = (q - 1) * 3 + 1
      monthNums = [start, start + 1, start + 2]
    } else {
      monthNums = [parseInt(effectivePeriod)]
    }

    const monthlyData = monthNums.map(m => ({
      num: m,
      label: MONTH_LABELS[m - 1],
      income: 0,
      expense: 0,
    }))

    const expenseByCategory = {}

    transactions.forEach(t => {
      const dateStr = (t.status === 'paid' && t.date_paid) ? t.date_paid : t.date_issued
      if (!dateStr) return
      const d = new Date(dateStr)
      if (isNaN(d.getTime())) return
      if (d.getFullYear() !== year) return
      const m = d.getMonth() + 1
      const idx = monthNums.indexOf(m)
      if (idx < 0) return

      const net = parseFloat(t.amount_net) || 0
      if (t.type === 'income' && t.status === 'paid') {
        monthlyData[idx].income += net
      } else if (t.type === 'expense') {
        monthlyData[idx].expense += net
        const code = t.category_code
        if (!expenseByCategory[code]) expenseByCategory[code] = 0
        expenseByCategory[code] += net
      }
    })

    const topExpenses = Object.entries(expenseByCategory)
      .map(([code, amount]) => {
        const cat = categories.find(c => c.code === parseInt(code))
        return { code: parseInt(code), name: cat?.name_fi || `Kulu ${code}`, amount }
      })
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6)

    const maxValue = Math.max(1, ...monthlyData.map(m => Math.max(m.income, m.expense)))
    const totalIncome = monthlyData.reduce((s, m) => s + m.income, 0)
    const totalExpense = monthlyData.reduce((s, m) => s + m.expense, 0)
    const totalProfit = totalIncome - totalExpense
    const maxExpense = topExpenses[0]?.amount || 1

    return { months: monthlyData, topExpenses, maxValue, totalIncome, totalExpense, totalProfit, maxExpense }
  }, [transactions, categories, reportYear, effectivePeriod])

  const hasData = data.totalIncome > 0 || data.totalExpense > 0
  if (!hasData) {
    // Muodosta selkokielinen aikavälin kuvaus
    let periodLabel = ''
    if (effectivePeriod === 'all') {
      periodLabel = `koko vuodelta ${reportYear}`
    } else if (effectivePeriod.startsWith('Q')) {
      const q = effectivePeriod
      const months = { Q1: 'tammi–maalis', Q2: 'huhti–kesä', Q3: 'heinä–syys', Q4: 'loka–joulu' }
      periodLabel = `${q} (${months[q]}) vuodelta ${reportYear}`
    } else {
      const monthNames = ['Tammikuu', 'Helmikuu', 'Maaliskuu', 'Huhtikuu', 'Toukokuu', 'Kesäkuu', 'Heinäkuu', 'Elokuu', 'Syyskuu', 'Lokakuu', 'Marraskuu', 'Joulukuu']
      periodLabel = `${monthNames[parseInt(effectivePeriod) - 1]} ${reportYear}`
    }

    return (
      <div className="report-card" style={{ marginBottom: '20px' }}>
        <h3>Taloudellinen tilanne</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '8px' }}>
          Ei tapahtumia aikavälillä: <strong>{periodLabel}</strong>.
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Vaihda vuosi, kvartaali tai kuukausi yllä olevista valikoista. Huomioithan, että
          tulot lasketaan mukaan vasta kun ne on merkitty <strong>maksetuiksi</strong>.
        </p>
      </div>
    )
  }

  const total = data.totalIncome + data.totalExpense
  const incomePct = total > 0 ? (data.totalIncome / total) * 100 : 0
  const expensePct = total > 0 ? (data.totalExpense / total) * 100 : 0
  const profitMargin = data.totalIncome > 0 ? (data.totalProfit / data.totalIncome) * 100 : 0

  return (
    <div style={{ display: 'grid', gap: '20px', marginBottom: '20px' }}>
      {/* Yhteenveto: tulot vs menot */}
      <div className="report-card">
        <h3>Taloudellinen tilanne</h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Tulot lasketaan mukaan vasta kun ne on merkitty maksetuiksi (maksupäivän mukaan).
          Menot kirjataan niiden päivämäärän mukaan.
        </p>
        <div style={{ display: 'flex', gap: '24px', marginBottom: '20px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '140px' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Tulot</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--success)' }}>{data.totalIncome.toFixed(2)} €</div>
          </div>
          <div style={{ flex: 1, minWidth: '140px' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Menot</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--danger)' }}>{data.totalExpense.toFixed(2)} €</div>
          </div>
          <div style={{ flex: 1, minWidth: '140px' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Tulos</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 700, color: data.totalProfit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
              {data.totalProfit.toFixed(2)} €
            </div>
            {data.totalIncome > 0 && (
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {profitMargin >= 0 ? '+' : ''}{profitMargin.toFixed(1)}% liikevaihdosta
              </div>
            )}
          </div>
        </div>

        {/* Yhteenvetopalkki */}
        <div style={{ display: 'flex', height: '14px', borderRadius: '7px', overflow: 'hidden', backgroundColor: 'var(--bg-main)' }}>
          <div style={{ width: `${incomePct}%`, backgroundColor: 'var(--success)', transition: 'width 0.3s' }} title={`Tulot ${data.totalIncome.toFixed(2)} €`}></div>
          <div style={{ width: `${expensePct}%`, backgroundColor: 'var(--danger)', transition: 'width 0.3s' }} title={`Menot ${data.totalExpense.toFixed(2)} €`}></div>
        </div>

        {data.totalProfit < 0 && (
          <p style={{ marginTop: '12px', fontSize: '0.9rem', color: 'var(--danger)', fontWeight: 600 }}>
            ⚠️ Menot ylittävät tulot {Math.abs(data.totalProfit).toFixed(2)} €:lla tällä aikavälillä.
          </p>
        )}
        {data.totalProfit > 0 && (
          <p style={{ marginTop: '12px', fontSize: '0.9rem', color: 'var(--success)', fontWeight: 600 }}>
            ✓ Voitollinen aikaväli — tulos {data.totalProfit.toFixed(2)} €.
          </p>
        )}
      </div>

      {/* Kuukausittainen palkkikuvaaja */}
      <div className="report-card">
        <h3>Kuukausittainen kehitys</h3>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', height: '220px', paddingTop: '20px', borderBottom: '1px solid var(--border-color)' }}>
          {data.months.map((m, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
              <div style={{ display: 'flex', gap: '2px', alignItems: 'flex-end', width: '100%', height: '100%', justifyContent: 'center' }}>
                <div
                  style={{
                    width: '45%',
                    maxWidth: '24px',
                    height: `${(m.income / data.maxValue) * 100}%`,
                    minHeight: m.income > 0 ? '2px' : '0',
                    backgroundColor: 'var(--success)',
                    borderRadius: '3px 3px 0 0',
                    transition: 'height 0.3s'
                  }}
                  title={`${m.label}: Tulot ${m.income.toFixed(2)} €`}
                ></div>
                <div
                  style={{
                    width: '45%',
                    maxWidth: '24px',
                    height: `${(m.expense / data.maxValue) * 100}%`,
                    minHeight: m.expense > 0 ? '2px' : '0',
                    backgroundColor: 'var(--danger)',
                    borderRadius: '3px 3px 0 0',
                    transition: 'height 0.3s'
                  }}
                  title={`${m.label}: Menot ${m.expense.toFixed(2)} €`}
                ></div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
          {data.months.map((m, i) => (
            <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {m.label.substring(0, 3)}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '16px', marginTop: '16px', fontSize: '0.85rem' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: 'var(--success)', borderRadius: '2px' }}></span>
            Tulot
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: 'var(--danger)', borderRadius: '2px' }}></span>
            Menot
          </span>
        </div>
      </div>

      {/* Suurimmat kuluerät */}
      {data.topExpenses.length > 0 && (
        <div className="report-card">
          <h3>Suurimmat kuluerät</h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
            Mihin raha on mennyt tällä aikavälillä.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {data.topExpenses.map((e, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) 2fr auto', gap: '12px', alignItems: 'center' }}>
                <span style={{ fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.name}>
                  {e.code} – {e.name}
                </span>
                <div style={{ height: '10px', backgroundColor: 'var(--bg-main)', borderRadius: '5px', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${(e.amount / data.maxExpense) * 100}%`,
                      height: '100%',
                      backgroundColor: 'var(--danger)',
                      borderRadius: '5px',
                      transition: 'width 0.3s'
                    }}
                  ></div>
                </div>
                <span style={{ fontSize: '0.85rem', fontFamily: 'monospace', fontWeight: 600, textAlign: 'right', minWidth: '80px' }}>
                  {e.amount.toFixed(2)} €
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function App() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showTositeModal, setShowTositeModal] = useState(false)
  const [showTositeConfirm, setShowTositeConfirm] = useState(false)
  const [showInvoiceConfirm, setShowInvoiceConfirm] = useState(false)
  // CSV-tuonnin tila
  const [showCsvImportModal, setShowCsvImportModal] = useState(false)
  const [csvParsing, setCsvParsing] = useState(false)
  const [csvRows, setCsvRows] = useState([])
  const [csvComparison, setCsvComparison] = useState(null)
  const [csvFileName, setCsvFileName] = useState('')
  const [csvError, setCsvError] = useState('')
  const [activeTab, setActiveTab] = useState('ledger')
  const [statusMessage, setStatusMessage] = useState('')
  const [transactions, setTransactions] = useState([])
  const [editingId, setEditingId] = useState(null)
  const [categories, setCategories] = useState([])
  const [customers, setCustomers] = useState([])
  const [isScanning, setIsScanning] = useState(false)
  const fileInputRef = useRef(null)
  const [reportYear, setReportYear] = useState(new Date().getFullYear().toString())
  const [reportPeriodType, setReportPeriodType] = useState('year')
  const [selectedQuarter, setSelectedQuarter] = useState('Q1')
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date()
    return String(now.getMonth() + 1).padStart(2, '0')
  })
  const effectivePeriod = useMemo(() => {
    if (reportPeriodType === 'year') return 'all'
    if (reportPeriodType === 'quarter') return selectedQuarter
    if (reportPeriodType === 'month') return selectedMonth
    return 'all'
  }, [reportPeriodType, selectedQuarter, selectedMonth])
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [isSettingsSaving, setIsSettingsSaving] = useState(false)
  const [invoiceData, setInvoiceData] = useState(DEFAULT_INVOICE_DATA)
  const [showCustomerModal, setShowCustomerModal] = useState(false)
  const [isInvoiceLoading, setIsInvoiceLoading] = useState(false)
  const [lastInvoiceUrl, setLastInvoiceUrl] = useState('')
  const [lastInvoiceNumber, setLastInvoiceNumber] = useState('')
  const [invoiceViewed, setInvoiceViewed] = useState(false)
  const [newCustomer, setNewCustomer] = useState({
    name: '', address: '', y_tunnus: '', email: '', phone: '', reference_number: ''
  })
  const isInvoiceFormValid = useMemo(() => {
    return (
      invoiceData.invoice_number.toString().trim() !== '' &&
      invoiceData.selectedCustomerId !== '' &&
      invoiceData.income_category !== '' &&
      invoiceData.lines.length > 0 &&
      invoiceData.lines.every(l =>
        l.description.trim() !== '' &&
        parseFloat(l.quantity) > 0 &&
        parseFloat(l.unit_price) > 0
      )
    )
  }, [invoiceData])
  // Laske rivien summat ja ALV-ryhmät
  const invoiceTotals = useMemo(() => {
    const groups = {} // { "25.5": { net, tax, gross }, "14": {...} }
    let netTotal = 0, taxTotal = 0, grossTotal = 0
    invoiceData.lines.forEach(line => {
      const qty = parseFloat(line.quantity) || 0
      const price = parseFloat(line.unit_price) || 0
      const rate = parseFloat(line.tax_rate) || 0
      const net = qty * price
      const tax = net * (rate / 100)
      const gross = net + tax
      netTotal += net
      taxTotal += tax
      grossTotal += gross
      const key = rate.toString()
      if (!groups[key]) groups[key] = { net: 0, tax: 0, gross: 0 }
      groups[key].net += net
      groups[key].tax += tax
      groups[key].gross += gross
    })
    return { netTotal, taxTotal, grossTotal, groups }
  }, [invoiceData.lines])
  const [formData, setFormData] = useState({
    type: 'expense',
    category_code: 346,
    contact_name: '',
    date_issued: new Date().toISOString().split('T')[0],
    amount_gross: '',
    tax_rate: 25.5,
    y_tunnus: '',
    receipt_url: null,
    expense_reference: '',   // <- uusi
  })
  const [ledgerMonthFilter, setLedgerMonthFilter] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const filteredTransactions = useMemo(() => {
  if (ledgerMonthFilter === 'all') return transactions
    return transactions.filter(t => {
      // Näytetään tapahtuma, jos joko päiväys TAI maksupäivä osuu suodattimeen
      const issuedMatches = t.date_issued && t.date_issued.startsWith(ledgerMonthFilter)
      const paidMatches = t.date_paid && t.date_paid.startsWith(ledgerMonthFilter)
      return issuedMatches || paidMatches
    })
  }, [transactions, ledgerMonthFilter])

  const handleExportData = async () => {
    const { data: transactions } = await supabase.from('transactions').select('*')
    const { data: customers } = await supabase.from('customers').select('*')
    const { data: merchants } = await supabase.from('merchants').select('*')
    const { data: settings } = await supabase.from('user_settings').select('*')
    const exportData = { exported_at: new Date().toISOString(), transactions, customers, merchants, settings }
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `lomake5_backup_${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  useEffect(() => {
    const initAuth = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      setUser(user)
      if (user) {
        await loadUserSettings(user.id)
        await fetchCategories()
        await fetchCustomers()
        await fetchTransactions()
      }
      setAuthLoading(false)
    }
    initAuth()
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        loadUserSettings(session.user.id)
        fetchCategories()
        fetchCustomers()
        fetchTransactions()
      }
    })
    return () => authListener.subscription.unsubscribe()
  }, [])

  const loadUserSettings = async (userId) => {
    const { data, error } = await supabase.from('user_settings').select('*').eq('user_id', userId).maybeSingle()
    if (error) { console.error("Failed to load settings:", error); return }
    if (data) {
      const mergedSettings = { ...DEFAULT_SETTINGS, ...data }
      setSettings({
        ...mergedSettings,
        default_tax_rate: String(mergedSettings.default_tax_rate),
        next_invoice_number: String(mergedSettings.next_invoice_number),
        delay_tax_rate: String(mergedSettings.delay_tax_rate),
      })
      setInvoiceData(prev => ({ ...prev, invoice_number: String(mergedSettings.next_invoice_number) }))
    } else {
      await supabase.from('user_settings').insert({ user_id: userId, ...DEFAULT_SETTINGS })
    }
  }

  const saveSettings = async (updatedSettings) => {
    if (!user) return
    await supabase.from('user_settings').update(updatedSettings).eq('user_id', user.id)
  }

  const fetchCategories = async () => {
    const { data } = await supabase.from('categories').select('*').order('code')
    if (data) setCategories(data)
  }

  const fetchCustomers = async () => {
    const { data } = await supabase.from('customers').select('*').order('name')
    if (data) setCustomers(data)
  }

  const fetchTransactions = async () => {
    const { data } = await supabase.from('transactions').select('*').order('date_issued', { ascending: false })
    if (data) setTransactions(data)
  }

  const resetInvoiceForm = (nextInvoiceNumber) => {
    setInvoiceData({
      ...DEFAULT_INVOICE_DATA,
      lines: [{ ...DEFAULT_INVOICE_LINE }],
      invoice_number: nextInvoiceNumber.toString(),
      date_issued: new Date().toISOString().split('T')[0],
    })
  }

  const handleFileUpload = async (e) => {
    const file = e.target.files[0]
    if (!file || !user) return
    setIsScanning(true)
    setStatusMessage('KÄSITTELEN...')
    const preprocessImage = (file) => new Promise((resolve) => {
      const img = new Image()
      img.src = URL.createObjectURL(file)
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        canvas.width = img.width
        canvas.height = img.height
        ctx.drawImage(img, 0, 0)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const data = imageData.data
        for (let i = 0; i < data.length; i += 4) {
          const avg = (data[i] + data[i + 1] + data[i + 2]) / 3
          const contrast = 1.5
          const newVal = ((avg / 255 - 0.5) * contrast + 0.5) * 255
          data[i] = data[i + 1] = data[i + 2] = Math.min(255, Math.max(0, newVal))
        }
        ctx.putImageData(imageData, 0, 0)
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.9)
      }
    })
    try {
      let text = ''
      if (file.type === 'application/pdf') {
        setStatusMessage('KÄSITTELEN...')
        const arrayBuffer = await file.arrayBuffer()
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
        const page = await pdf.getPage(1)
        const viewport = page.getViewport({ scale: 2.0 })
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        canvas.width = viewport.width
        canvas.height = viewport.height
        await page.render({ canvasContext: context, viewport }).promise
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        setStatusMessage('TUNNISTAN TEKSTIÄ...')
        const { data } = await Tesseract.recognize(blob, 'fin+eng', {
          logger: m => { if (m.status === 'recognizing text') setStatusMessage(`TUNNISTAN TEKSTIÄ... ${Math.round(m.progress * 100)}%`) }
        })
        text = data.text
      } else {
        setStatusMessage('KÄSITTELEN...')
        const processedFile = await preprocessImage(file)
        setStatusMessage('TUNNISTAN TEKSTIÄ...')
        const { data } = await Tesseract.recognize(processedFile, 'fin+eng', {
          logger: m => { if (m.status === 'recognizing text') setStatusMessage(`TUNNISTAN TEKSTIÄ... ${Math.round(m.progress * 100)}%`) }
        })
        text = data.text
      }
      if (text && text.trim().length > 0) {
        await parseReceiptText(text, file)
        setStatusMessage('VALMIS. TARKISTA TIEDOT.')
      } else {
        setStatusMessage('SYÖTÄ TIEDOT KÄSIN')
      }
    } catch (err) {
      console.error('OCR error:', err)
      setStatusMessage('OCR-virhe. Syötä tiedot käsin.')
    } finally {
      setIsScanning(false)
    }
  }

  const compressImage = async (file, maxWidth = 1200, maxHeight = 1200, quality = 0.7) => {
    return new Promise((resolve) => {
      const img = new Image()
      img.src = URL.createObjectURL(file)
      img.onload = () => {
        let width = img.width, height = img.height
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height)
          width = Math.round(width * ratio)
          height = Math.round(height * ratio)
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, width, height)
        canvas.toBlob((blob) => { URL.revokeObjectURL(img.src); resolve(blob) }, 'image/jpeg', quality)
      }
    })
  }

    const parseReceiptText = async (text, imageFile) => {
    let newDate = formData.date_issued, newAmount = formData.amount_gross, newTax = formData.tax_rate
    let newContact = '', newCategory = formData.category_code, detectedYTunnus = ''

    // 1) Y-tunnus → kauppiaan oletusnimi
    const yRegex = /\b\d{7}-\d\b/
    const yMatch = text.match(yRegex)
    if (yMatch) {
      detectedYTunnus = yMatch[0]
      const { data: merchant } = await supabase.from('merchants').select('*').eq('y_tunnus', detectedYTunnus).eq('user_id', user.id).single()
      if (merchant) { newContact = merchant.name; newCategory = merchant.default_category_code }
    }

    // 2) Etsi asiakkaista (koko teksti normalisoituna, pisin osuma voittaa)
    if (!newContact) {
      const textNorm = normalizeName(text)
      const customerCandidates = customers
        .map(c => ({ name: c.name, norm: normalizeName(c.name) }))
        .filter(c => c.norm.length >= 4 && textNorm.includes(c.norm))
        .sort((a, b) => b.norm.length - a.norm.length)
      if (customerCandidates.length > 0) newContact = customerCandidates[0].name
    }

    // 3) Etsi aiemmista tapahtumista (contact_name)
    if (!newContact) {
      const textNorm = normalizeName(text)
      const uniqueNames = [...new Set(transactions.map(t => t.contact_name).filter(Boolean))]
      const txCandidates = uniqueNames
        .map(n => ({ name: n, norm: normalizeName(n) }))
        .filter(n => n.norm.length >= 4 && textNorm.includes(n.norm))
        .sort((a, b) => b.norm.length - a.norm.length)
      if (txCandidates.length > 0) newContact = txCandidates[0].name
    }

    // 4) Fallback: ensimmäinen siisti rivi
    if (!newContact) {
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2)
      const blacklist = ['kuitti', 'tervetuloa', 'pvm', 'pvm.', 'fax', 'tel', 'puh', 'käteiskuitti', 'y-tunnus', 'alv', 'yhteensä', 'summa']
      const cleanLines = lines.filter(l => {
        const lower = l.toLowerCase()
        if (blacklist.some(b => lower.includes(b))) return false
        if (/^[\d\s.,\-€%]+$/.test(l)) return false // pelkät numerot ja symbolit
        return true
      })
      newContact = cleanLines[0] || ''
    }

    const amountRegex = /\b\d{1,4}[.,]\d{2}\b/g
    const amounts = text.match(amountRegex)
    if (amounts) {
      const numericAmounts = amounts.map(a => parseFloat(a.replace(',', '.')))
      const filtered = numericAmounts.filter(a => a !== 25.5 && a !== 24 && a !== 14 && a !== 10)
      if (filtered.length > 0) newAmount = Math.max(...filtered).toFixed(2)
    }
    const dateRegex = /(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{2,4})/g
    const dates = [...text.matchAll(dateRegex)]
    if (dates.length > 0) {
      const currentYear = new Date().getFullYear()
      // Muodosta ehdokkaat ja tulkitse 2-numeroiset vuodet 1900/2000-luvuiksi
      const candidates = dates
        .map(m => {
          let [, d, mo, y] = m
          let year
          if (y.length === 2) {
            year = parseInt(y, 10) > 50 ? 1900 + parseInt(y, 10) : 2000 + parseInt(y, 10)
          } else {
            year = parseInt(y, 10)
          }
          return { d: parseInt(d, 10), mo: parseInt(mo, 10), y: year }
        })
        .filter(c => c.mo >= 1 && c.mo <= 12 && c.d >= 1 && c.d <= 31)
        .filter(c => c.y >= 2000 && c.y <= currentYear + 1) // hylkää selvästi virheelliset
      if (candidates.length > 0) {
        // Valitse vuosi, joka on lähimpänä kuluvaa vuotta (tai edellistä)
        candidates.sort((a, b) => {
          const da = a.y <= currentYear ? currentYear - a.y : a.y - currentYear + 1000
          const db = b.y <= currentYear ? currentYear - b.y : b.y - currentYear + 1000
          return da - db
        })
        const best = candidates[0]
        newDate = `${best.y}-${String(best.mo).padStart(2, '0')}-${String(best.d).padStart(2, '0')}`
      }
    }
    let receiptUrl = null
    if (imageFile) {
      try {
        let fileToUpload = imageFile
        if (imageFile.type.startsWith('image/')) {
          setStatusMessage('TALLENNAN...')
          const compressedBlob = await compressImage(imageFile, 1200, 1200, 0.7)
          fileToUpload = new File([compressedBlob], imageFile.name.replace(/\.[^/.]+$/, '.jpg'), { type: 'image/jpeg' })
        }
        const fileExt = fileToUpload.name.split('.').pop()
        const fileName = `${user.id}/${Date.now()}_receipt.${fileExt}`
        const { error: uploadError } = await supabase.storage.from('receipts').upload(fileName, fileToUpload)
        if (!uploadError) {
          const { data: signedData, error: signedError } = await supabase.storage.from('receipts').createSignedUrl(fileName, 1209600)
          if (!signedError) receiptUrl = signedData.signedUrl
        }
      } catch (err) { console.warn('Image upload failed:', err) }
    }
    setFormData(prev => ({ ...prev, contact_name: newContact, date_issued: newDate, amount_gross: newAmount, tax_rate: newTax, category_code: newCategory, y_tunnus: detectedYTunnus, receipt_url: receiptUrl }))
  }

  const handleLedgerSubmit = (e) => {
    e.preventDefault()
    if (!user) return

    // Perusvalidoinnit (samat kuin ennen)
    if (!formData.contact_name || !formData.contact_name.trim()) {
      alert('Nimi puuttuu. Täytä se ennen tallennusta.')
      return
    }
    if (!formData.amount_gross || parseFloat(formData.amount_gross) <= 0) {
      alert('Summan pitää olla suurempi kuin 0.')
      return
    }
    if (parseFloat(formData.amount_gross) > 100000) {
      const proceed = window.confirm(
        `Summa ${parseFloat(formData.amount_gross).toFixed(2)} € vaikuttaa erittäin suurelta.\n\nOnko summa varmasti oikein?`
      )
      if (!proceed) return
    }
    if (isDateSuspicious(formData.date_issued)) {
      const year = new Date(formData.date_issued).getFullYear()
      const proceed = window.confirm(
        `Päivämäärän vuosi on ${year}, mikä poikkeaa kuluvasta vuodesta.\n\nOnko päivämäärä varmasti oikein?`
      )
      if (!proceed) return
    }
    if (formData.type === 'income') {
      const expectedTax = INCOME_TAX_RATES[parseInt(formData.category_code)]
      if (expectedTax !== undefined && parseFloat(formData.tax_rate) !== expectedTax) {
        const proceed = window.confirm(
          `Valitsit tulokategorian, jonka oletusverokanta on ${expectedTax}%, mutta valitsit ${formData.tax_rate}%.\n\nHaluatko jatkaa?`
        )
        if (!proceed) return
      }
    }

    // Näytä esikatselu sen sijaan että tallennettaisiin suoraan
    setShowTositeConfirm(true)
  }

  // Varsinainen tallennus – kutsutaan esikatselun "Vahvista"-napista
  const confirmTositeSave = async () => {
    setShowTositeConfirm(false)
    setStatusMessage(editingId ? 'Updating...' : 'Saving...')
    const gross = parseFloat(formData.amount_gross)
    const taxMultiplier = 1 + (parseFloat(formData.tax_rate) / 100)
    const net = gross / taxMultiplier
    const isExpense = formData.type === 'expense'

    if (!editingId) {
      const { data: duplicates } = await supabase.from('transactions').select('id')
        .eq('contact_name', formData.contact_name)
        .eq('date_issued', formData.date_issued)
        .eq('amount_gross', gross)
        .maybeSingle()
      if (duplicates) {
        const proceed = window.confirm(
          'Vaikuttaa siltä, että tämä tosite on jo kirjattu (sama nimi, päivä ja summa).\n\nHaluatko silti lisätä?'
        )
        if (!proceed) return
      }
    }

    const payload = {
      user_id: user.id,
      type: formData.type,
      category_code: parseInt(formData.category_code),
      contact_name: formData.contact_name,
      date_issued: formData.date_issued,
      amount_gross: gross,
      tax_rate: parseFloat(formData.tax_rate),
      amount_net: parseFloat(net.toFixed(2)),
      status: isExpense ? 'paid' : 'unpaid',
      date_paid: isExpense ? formData.date_issued : null,
      receipt_image_url: formData.receipt_url || null,
      expense_reference: formData.expense_reference?.trim() || null,   // <- uusi
    }

    let dbError
    if (editingId) {
      ({ error: dbError } = await supabase.from('transactions').update(payload).eq('id', editingId))
    } else {
      const { error } = await supabase.from('transactions').insert([payload])
      dbError = error
      if (!error && isExpense && formData.y_tunnus) {
        await supabase.from('merchants').upsert({
          user_id: user.id, y_tunnus: formData.y_tunnus, name: formData.contact_name,
          default_category_code: parseInt(formData.category_code)
        }, { onConflict: 'user_id, y_tunnus' })
      }
    }

    if (!dbError) {
      setStatusMessage('VALMIS!')
      cancelEdit()
      setShowTositeModal(false)
      fetchTransactions()
    } else {
      setStatusMessage('Database Error: ' + dbError.message)
    }
    setTimeout(() => setStatusMessage(''), 3000)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setFormData({ type: 'expense', category_code: 346, contact_name: '', date_issued: new Date().toISOString().split('T')[0], amount_gross: '', tax_rate: settings.default_tax_rate || 25.5, y_tunnus: '', receipt_url: null, expense_reference: '' })
  }

  const handleEditClick = (t) => {
    setEditingId(t.id)
    setFormData({ type: t.type, category_code: t.category_code, contact_name: t.contact_name, date_issued: t.date_issued, amount_gross: t.amount_gross, tax_rate: String(t.tax_rate), y_tunnus: '', receipt_url: t.receipt_image_url, expense_reference: t.expense_reference || '' })
    setShowTositeModal(true)
  }

  const handleDelete = async (id) => {
    if (!window.confirm("Poistetaanko tapahtuma?")) return
    const { data: transaction, error: fetchError } = await supabase.from('transactions').select('receipt_image_url, invoice_pdf_url').eq('id', id).single()
    if (fetchError) { alert('Virhe haettaessa tietoja: ' + fetchError.message); return }
    const { error: deleteError } = await supabase.from('transactions').delete().eq('id', id)
    if (deleteError) { alert('Virhe poistettaessa: ' + deleteError.message); return }
    const fileUrl = transaction?.receipt_image_url || transaction?.invoice_pdf_url
    if (fileUrl) {
      try {
        let bucket = '', path = ''
        if (fileUrl.includes('/receipts/')) { bucket = 'receipts'; const match = fileUrl.match(/\/receipts\/([^?]+)/); if (match) path = decodeURIComponent(match[1]) }
        else if (fileUrl.includes('/invoices/')) { bucket = 'invoices'; const match = fileUrl.match(/\/invoices\/([^?]+)/); if (match) path = decodeURIComponent(match[1]) }
        if (bucket && path) await supabase.storage.from(bucket).remove([path])
      } catch (err) { console.warn('File deletion warning:', err) }
    }
    fetchTransactions()
  }

  // CSV-tiedoston lataus ja jäsentäminen
  const handleCsvFileUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvParsing(true)
    setCsvError('')
    try {
      const text = await readFileAsText(file)
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
      if (lines.length < 2) {
        setCsvError('CSV-tiedosto näyttää tyhjältä tai siitä puuttuu otsikkorivi.')
        setCsvParsing(false)
        return
      }

      const delimiter = detectDelimiter(lines[0])
      const headers = parseCsvLine(lines[0], delimiter)
      const cols = detectColumns(headers)

      if (cols.date < 0 || cols.amount < 0 || cols.name < 0) {
        setCsvError(`Sarakkeita ei tunnistettu. Otsikot: ${headers.join(', ')}`)
        setCsvParsing(false)
        return
      }

      const rows = []
      for (let i = 1; i < lines.length; i++) {
        const cells = parseCsvLine(lines[i], delimiter)
        const date = parseCsvDate(cells[cols.date])
        const amount = parseCsvAmount(cells[cols.amount])
        const name = (cells[cols.name] || '').trim()
        const message = cols.message >= 0 ? (cells[cols.message] || '').trim() : ''
        if (!date || isNaN(amount)) continue
        rows.push({ date, amount, name, message })
      }

      if (rows.length === 0) {
        setCsvError('Tiedostosta ei löytynyt yhtään kelvollista tapahtumaa.')
        setCsvParsing(false)
        return
      }

      setCsvRows(rows)
      setCsvFileName(file.name)
    } catch (err) {
      setCsvError('Virhe tiedoston lukemisessa: ' + err.message)
    } finally {
      setCsvParsing(false)
      if (e.target) e.target.value = ''
    }
  }

  // Päivitä sovelluksen tapahtuman nimi pankin nimeksi (vain käyttäjän vahvistuksella)
  const handleCsvUpdateName = async (txId, newName) => {
    if (!window.confirm(`Päivitetäänkö sovelluksen tapahtuman nimeksi "${newName}"?`)) return
    const { error } = await supabase.from('transactions').update({ contact_name: newName }).eq('id', txId)
    if (error) alert('Virhe: ' + error.message)
    else fetchTransactions()
  }

  // Avaa sovelluksen tapahtuma muokattavaksi CSV-vertailusta
  // (sama kuin handleEditClick, mutta nimetty CSV-kontekstiin)
  const handleCsvEditTx = (tx) => {
    handleEditClick(tx)
  }

  // Luo uusi tosite CSV-rivistä (avataan tosite-modaali esitäytetyillä tiedoilla)
  const handleCsvCreateTx = (row) => {
    const isExpense = row.amount < 0
    setFormData({
      type: isExpense ? 'expense' : 'income',
      category_code: isExpense ? 346 : 3001,
      contact_name: row.name,
      date_issued: row.date,
      amount_gross: Math.abs(row.amount).toFixed(2),
      tax_rate: String(isExpense ? (settings.default_tax_rate || 25.5) : (INCOME_TAX_RATES[3001] || 25.5)),
      y_tunnus: '',
      receipt_url: null,
    })
    setEditingId(null)
    setShowTositeModal(true)
  }

  // Sulje CSV-modaali ja nollaa tila
  const handleCsvClose = () => {
    setShowCsvImportModal(false)
    setCsvRows([])
    setCsvComparison(null)
    setCsvFileName('')
    setCsvError('')
  }

  // Tarkista, onko päivämäärä epäilyttävä (ei kuluva tai edellinen vuosi)
  const isDateSuspicious = (dateStr) => {
    if (!dateStr) return false
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return false
    const currentYear = new Date().getFullYear()
    const y = d.getFullYear()
    return y < currentYear - 1 || y > currentYear
  }

  const handleStatusToggle = async (t) => {
    if (t.type === 'expense') { alert('Kuitit merkataan aina maksetuksi'); return }

    if (t.status === 'unpaid') {
      // Etsi kaikki saman laskun rivit (sama viitenumero + asiakas + päivä)
      const sameInvoice = t.reference_number
        ? transactions.filter(x =>
            x.type === 'income' &&
            x.reference_number === t.reference_number &&
            x.contact_name === t.contact_name
          )
        : [t]

      const today = new Date().toISOString().split('T')[0]
      const paymentDate = window.prompt(
        sameInvoice.length > 1
          ? `Syötä maksupäivä laskulle ${t.reference_number} (${sameInvoice.length} riviä, yhteensä ${sameInvoice.reduce((s, x) => s + parseFloat(x.amount_gross), 0).toFixed(2)} €):`
          : "Syötä maksupäivä (YYYY-MM-DD):",
        today
      )
      if (!paymentDate) return

      const ids = sameInvoice.map(x => x.id)
      const { error } = await supabase
        .from('transactions')
        .update({ status: 'paid', date_paid: paymentDate })
        .in('id', ids)
      if (error) alert('Virhe: ' + error.message)
      else fetchTransactions()
    } else {
      // Merkitse maksamattomaksi – sama logiikka
      const sameInvoice = t.reference_number
        ? transactions.filter(x =>
            x.type === 'income' &&
            x.reference_number === t.reference_number &&
            x.contact_name === t.contact_name
          )
        : [t]

      if (window.confirm(
        sameInvoice.length > 1
          ? `Merkitäänkö koko lasku ${t.reference_number} (${sameInvoice.length} riviä) maksamattomaksi?`
          : "Merkitäänkö maksamattomaksi?"
      )) {
        const ids = sameInvoice.map(x => x.id)
        const { error } = await supabase
          .from('transactions')
          .update({ status: 'unpaid', date_paid: null })
          .in('id', ids)
        if (error) alert('Virhe: ' + error.message)
        else fetchTransactions()
      }
    }
  }

  const handleInvoiceChange = (e) => {
    setInvoiceData({ ...invoiceData, [e.target.name]: e.target.value })
    if (lastInvoiceUrl) { setLastInvoiceUrl(''); setLastInvoiceNumber(''); setInvoiceViewed(false) }
  }

  const confirmInvoiceSave = async () => {
    setShowInvoiceConfirm(false)
    if (!user) return
    setIsInvoiceLoading(true)
    setStatusMessage('LUON LASKUA...')
    try {
      const generatedReference = generoiViitenumero(parseInt(invoiceData.invoice_number))
      const { netTotal, taxTotal, grossTotal, groups } = invoiceTotals

      const issueDate = new Date(invoiceData.date_issued)
      const dueDate = new Date(issueDate)
      dueDate.setDate(dueDate.getDate() + 14)
      const formattedDueDate = dueDate.toISOString().split('T')[0]

      const safeSettings = {
        company_name: settings.company_name || 'Yritys Oy',
        company_address: settings.company_address || 'Osoite',
        company_phone: settings.company_phone || '',
        company_email: settings.company_email || '',
        company_iban: settings.company_iban || '',
        company_swift: settings.company_swift || '',
        business_id: settings.business_id || '',
        company_vat: settings.company_vat || '',
        delay_tax_rate: settings.delay_tax_rate || '11.00'
      }

      // ===== PDF =====
      const doc = new jsPDF()
      doc.setFontSize(22); doc.setFont(undefined, 'bold')
      doc.text(safeSettings.company_name, 14, 20)
      doc.text('LASKU', 196, 20, { align: 'right' })

      doc.setFontSize(12); doc.setFont(undefined, 'normal')
      doc.text(invoiceData.buyer_name || 'Asiakas', 14, 35)
      doc.text(doc.splitTextToSize(invoiceData.buyer_address || '', 80), 14, 41)

      autoTable(doc, {
        startY: 28, margin: { left: 120 }, theme: 'plain',
        body: [
          ['Laskun numero', invoiceData.invoice_number || ''],
          ['Laskun päiväys', invoiceData.date_issued?.split('-').reverse().join('.') || ''],
          ['Maksuehto', '14 päivää'],
          ['Eräpäivä', formattedDueDate?.split('-').reverse().join('.') || ''],
          ['Viivästyskorko', safeSettings.delay_tax_rate + '%'],
          ['Viitenumero', generatedReference]
        ],
        styles: { fontSize: 10, cellPadding: 1 },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 40 } }
      })

      // Rivit-taulukko
      autoTable(doc, {
        startY: Math.max(doc.lastAutoTable.finalY + 10, 65),
        head: [['Kuvaus', 'Määrä', 'á-hinta', 'ALV %', 'Yhteensä (alv 0%)']],
        body: invoiceData.lines.map(l => {
          const qty = parseFloat(l.quantity) || 0
          const price = parseFloat(l.unit_price) || 0
          const net = qty * price
          return [l.description, qty, price.toFixed(2) + '€', l.tax_rate + '%', net.toFixed(2) + '€']
        }),
        theme: 'grid',
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0] },
        styles: { fontSize: 10 }
      })

      const finalY = doc.lastAutoTable.finalY
      doc.setFontSize(10); doc.setFont(undefined, 'bold')
      doc.text('Hankkeen tiedot', 14, finalY + 10)
      doc.setFont(undefined, 'normal')
      doc.text(invoiceData.project_details || '', 14, finalY + 16)

      if (invoiceData.expense_reference?.trim()) {
        doc.setFontSize(9); doc.setTextColor(80, 80, 80)
        doc.text(`Kuluviite: ${invoiceData.expense_reference}`, 14, finalY + 22)
        doc.setTextColor(0, 0, 0)
      }

      // ALV-erittely + loppusumma
      const totalsBody = [
        ['Yhteensä (alv 0%)', netTotal.toFixed(2) + '€'],
        ...Object.entries(groups)
          .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
          .map(([rate, g]) => [`ALV ${rate}%`, g.tax.toFixed(2) + '€']),
        ['Maksettava yhteensä', grossTotal.toFixed(2) + '€']
      ]

      autoTable(doc, {
        startY: finalY + 10, margin: { left: 120 }, theme: 'plain',
        body: totalsBody,
        styles: { fontSize: 10, cellPadding: 1.5 },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 50 }, 1: { halign: 'right' } }
      })

      // Footer
      const footerY = 270
      doc.setFontSize(8); doc.setTextColor(100, 100, 100)
      doc.text(`${safeSettings.company_name} | ${safeSettings.company_address}`, 105, footerY, { align: 'center' })
      doc.text(`Puh: ${safeSettings.company_phone} | Sähköposti: ${safeSettings.company_email}`, 105, footerY + 5, { align: 'center' })
      doc.text(`IBAN: ${safeSettings.company_iban} | SWIFT: ${safeSettings.company_swift}`, 105, footerY + 10, { align: 'center' })
      doc.text(`Y-tunnus: ${safeSettings.business_id} | ALV-nro: ${safeSettings.company_vat}`, 105, footerY + 15, { align: 'center' })

      // ===== Tallenna PDF =====
      const pdfBlob = doc.output('blob')
      const pdfFileName = `${user.id}/invoice_${invoiceData.invoice_number}_${Date.now()}.pdf`
      const { error: uploadError } = await supabase.storage.from('invoices').upload(pdfFileName, pdfBlob, { contentType: 'application/pdf', cacheControl: '3600' })

      let pdfUrl = null
      if (!uploadError) {
        const { data: signedData, error: signedError } = await supabase.storage.from('invoices').createSignedUrl(pdfFileName, 1209600)
        if (!signedError) {
          pdfUrl = signedData.signedUrl
          setLastInvoiceUrl(pdfUrl)
          setLastInvoiceNumber(invoiceData.invoice_number)
        }
      }

      // ===== Tietokantaan: yksi tapahtuma per ALV-ryhmä =====
      const txRows = Object.entries(groups).map(([rate, g]) => {
        const linesWithRate = invoiceData.lines.filter(l => parseFloat(l.tax_rate) === parseFloat(rate))
        const description = linesWithRate.map(l => l.description).filter(Boolean).join(', ')
        return {
          user_id: user.id,
          type: 'income',
          category_code: parseInt(invoiceData.income_category),
          contact_name: invoiceData.buyer_name,
          date_issued: invoiceData.date_issued,
          due_date: formattedDueDate,
          amount_gross: g.gross,
          tax_rate: parseFloat(rate),
          amount_net: g.net,
          status: 'unpaid',
          description,
          invoice_pdf_url: pdfUrl,
          reference_number: generatedReference,
          expense_reference: invoiceData.expense_reference?.trim() || null,   // <- uusi
        }
      })

      const { error: dbError } = await supabase.from('transactions').insert(txRows)

      // Päivitä asiakas
      await supabase.from('customers').upsert({
        user_id: user.id,
        name: invoiceData.buyer_name,
        address: invoiceData.buyer_address
      }, { onConflict: 'user_id, name' })

      const nextNum = parseInt(invoiceData.invoice_number) + 1
      await saveSettings({ next_invoice_number: nextNum })
      resetInvoiceForm(nextNum)

      if (pdfUrl) window.open(pdfUrl, '_blank')
      if (!dbError) {
        fetchTransactions()
        setStatusMessage('LASKU VALMIS')
        setTimeout(() => setStatusMessage(''), 3000)
      } else {
        setStatusMessage('VIRHE: ' + dbError.message)
      }
    } catch (err) {
      setStatusMessage('VIRHE: ' + err.message)
    } finally {
      setIsInvoiceLoading(false)
    }
  }

  const handleInvoiceSubmit = (e) => {
    e.preventDefault()
    if (!user) return

    // Perusvalidoinnit
    if (invoiceData.lines.length === 0) {
      alert('Laskulla pitää olla vähintään yksi rivi.')
      return
    }
    if (invoiceData.lines.some(l => (parseFloat(l.quantity) || 0) <= 0)) {
      alert('Jokaisella rivillä pitää olla positiivinen määrä.')
      return
    }
    if (invoiceData.lines.some(l => (parseFloat(l.unit_price) || 0) <= 0)) {
      alert('Jokaisella rivillä pitää olla positiivinen á-hinta.')
      return
    }

    // Tarkista yritystiedot
    const missingSettings = []
    if (!settings.company_name?.trim()) missingSettings.push('Yrityksen nimi')
    if (!settings.company_iban?.trim()) missingSettings.push('IBAN')
    if (!settings.business_id?.trim()) missingSettings.push('Y-tunnus')

    if (missingSettings.length > 0) {
      const proceed = window.confirm(
        `Seuraavat yritystiedot puuttuvat:\n\n${missingSettings.join('\n')}\n\n` +
        `Lasku luodaan joka tapauksessa, mutta se ei ole virallinen.\n\n` +
        `Suosittelemme täyttämään tiedot Asetukset-sivulla ensin.\n\n` +
        `Jatketaanko silti?`
      )
      if (!proceed) return
    }

    // Tarkista asiakkaan tiedot
    if (!invoiceData.buyer_address?.trim()) {
      const proceed = window.confirm(
        'Asiakkaan osoite puuttuu. Laskua ei voi lähettää virallisesti.\n\nJatketaanko?'
      )
      if (!proceed) return
    }

    const zeroVatLines = invoiceData.lines.filter(l => parseFloat(l.tax_rate) === 0)
    if (zeroVatLines.length > 0) {
      const proceed = window.confirm(
        `Laskulla on ${zeroVatLines.length} rivi(ä) ALV 0%:\n\n` +
        zeroVatLines.map(l => `• ${l.description}`).join('\n') +
        `\n\nOnko tämä tarkoituksellista (esim. EU-myynti tai 0-verokanta)?`
      )
      if (!proceed) return
    }

    // Näytä esikatselu
    setShowInvoiceConfirm(true)
  }


  // Tyhjennä viimeisin laskuinfo, kun käyttäjä muokkaa lomaketta
  const clearLastInvoice = () => {
    if (lastInvoiceUrl) {
      setLastInvoiceUrl('')
      setLastInvoiceNumber('')
      setInvoiceViewed(false)
    }
  }

  // Muokkaa yksittäistä riviä
  const handleLineChange = (index, field, value) => {
    setInvoiceData(prev => {
      const lines = [...prev.lines]
      lines[index] = { ...lines[index], [field]: value }
      return { ...prev, lines }
    })
    clearLastInvoice()
  }

  // Lisää uusi tyhjä rivi (perii nykyisen kategorian oletus-ALV:n)
  const handleAddLine = () => {
    const defaultRate = String(INCOME_TAX_RATES[parseInt(invoiceData.income_category, 10)] ?? 25.5)
    setInvoiceData(prev => ({
      ...prev,
      lines: [...prev.lines, { ...DEFAULT_INVOICE_LINE, tax_rate: defaultRate }]
    }))
    clearLastInvoice()
  }

  // Poista rivi (vähintään 1 rivi täytyy jäädä)
  const handleRemoveLine = (index) => {
    setInvoiceData(prev => {
      if (prev.lines.length <= 1) return prev
      return { ...prev, lines: prev.lines.filter((_, i) => i !== index) }
    })
    clearLastInvoice()
  }

  // Vaihda tulon tyyppi – päivitä rivien ALV vain, jos ne käyttävät vanhaa oletusta
  const handleIncomeCategoryChange = (category) => {
    const newRate = String(INCOME_TAX_RATES[parseInt(category, 10)] ?? 25.5)
    setInvoiceData(prev => {
      const oldRate = String(INCOME_TAX_RATES[parseInt(prev.income_category, 10)] ?? 25.5)
      const lines = prev.lines.map(line =>
        line.tax_rate === oldRate ? { ...line, tax_rate: newRate } : line
      )
      return { ...prev, income_category: category, lines }
    })
    clearLastInvoice()
  }

  const reportData = useMemo(() => {
    let totalVatCollected = 0, totalVatPaid = 0, totalIncomeNet = 0, totalExpenseNet = 0
    const alvSalesTax = {}
    let zeroTaxSalesNet = 0
    const expensesByCategory = {}
    let euSalesGoods = 0, euSalesServices = 0, euPurchasesGoods = 0, euPurchasesServices = 0
    let importGoods = 0, reverseChargeSales = 0, reverseChargePurchases = 0
    transactions.forEach(t => {
      const accountingDateStr = (t.status === 'paid' && t.date_paid) ? t.date_paid : t.date_issued
      const date = new Date(accountingDateStr)
      if (date.getFullYear().toString() !== reportYear) return
      if (effectivePeriod !== 'all') {
        const month = date.getMonth() + 1
        if (effectivePeriod.startsWith('Q')) { const q = parseInt(effectivePeriod[1]); if (q === 1 && month > 3) return; if (q === 2 && (month < 4 || month > 6)) return; if (q === 3 && (month < 7 || month > 9)) return; if (q === 4 && month < 10) return }
        else { if (month.toString().padStart(2, '0') !== effectivePeriod) return }
      }
      const net = parseFloat(t.amount_net), gross = parseFloat(t.amount_gross), vatAmount = gross - net, code = t.category_code
      if (t.type === 'income' && t.status === 'paid') {
        if (code === 3004 || code === 3005 || code === 3006 || code === 3010 || code === 3011) zeroTaxSalesNet += net
        if (code === 3010) euSalesGoods += net
        if (code === 3011) euSalesServices += net
        if (code === 3901 || code === 3903) reverseChargeSales += net
        totalVatCollected += vatAmount; totalIncomeNet += net
        if (t.tax_rate === 0) {} else { const key = t.tax_rate.toString(); if (!alvSalesTax[key]) alvSalesTax[key] = 0; alvSalesTax[key] += vatAmount }
      } else if (t.type === 'expense') {
        totalVatPaid += vatAmount; totalExpenseNet += net
        if (!expensesByCategory[code]) expensesByCategory[code] = 0; expensesByCategory[code] += net
        if (code === 3701) euPurchasesGoods += net; if (code === 3702) euPurchasesServices += net
        if (code === 3801) importGoods += net; if (code === 3902 || code === 3904) reverseChargePurchases += net
      }
    })
    return { vatToPay: totalVatCollected - totalVatPaid, totalVatCollected, totalVatPaid, totalIncomeNet, totalExpenseNet, profit: totalIncomeNet - totalExpenseNet, alvSalesTax, zeroTaxSalesNet, expensesByCategory, euSalesGoods, euSalesServices, euPurchasesGoods, euPurchasesServices, importGoods, reverseChargeSales, reverseChargePurchases }
  }, [transactions, reportYear, effectivePeriod])

  // Etsi laskut, joissa osa riveistä on maksettu ja osa ei
  const partiallyPaidInvoices = useMemo(() => {
    const groups = {}
    transactions.forEach(t => {
      if (t.type !== 'income' || !t.reference_number) return
      const key = `${t.reference_number}_${t.contact_name}`
      if (!groups[key]) groups[key] = { ref: t.reference_number, customer: t.contact_name, paid: [], unpaid: [] }
      if (t.status === 'paid') groups[key].paid.push(t)
      else groups[key].unpaid.push(t)
    })
    return Object.values(groups).filter(g => g.paid.length > 0 && g.unpaid.length > 0)
  }, [transactions])

  // Vertailu päivittyy automaattisesti, kun tapahtumat tai CSV-rivit muuttuvat
  useEffect(() => {
    if (csvRows.length > 0) {
      setCsvComparison(compareCsvToTransactions(csvRows, transactions))
    } else {
      setCsvComparison(null)
    }
  }, [csvRows, transactions])

  const availableYears = useMemo(() => {
    const years = new Set(); const currentYear = new Date().getFullYear()
    transactions.forEach(t => { const dateStr = (t.status === 'paid' && t.date_paid) ? t.date_paid : t.date_issued; if (dateStr) { const year = new Date(dateStr).getFullYear(); if (!isNaN(year)) years.add(year) } })
    years.add(currentYear)
    return Array.from(years).sort((a, b) => b - a)
  }, [transactions])

  useEffect(() => { if (availableYears.length > 0 && !availableYears.includes(parseInt(reportYear))) setReportYear(availableYears[0].toString()) }, [availableYears, reportYear])

  const handleSettingsChange = (e) => { const { name, value } = e.target; setSettings(prev => ({ ...prev, [name]: value || '' })) }

  const handleSettingsSave = async () => {
    if (!user) return
    setIsSettingsSaving(true); setStatusMessage('TALLENNETAAN ASETUKSIA...')
    const dbSettings = { company_name: settings.company_name || '', company_address: settings.company_address || '', company_phone: settings.company_phone || '', company_email: settings.company_email || '', company_iban: settings.company_iban || '', company_swift: settings.company_swift || '', company_vat: settings.company_vat || '', business_id: settings.business_id || '', default_tax_rate: parseFloat(settings.default_tax_rate) || 25.5, invoice_prefix: settings.invoice_prefix || 'INV', next_invoice_number: parseInt(settings.next_invoice_number) || 1, delay_tax_rate: parseFloat(settings.delay_tax_rate) || 11.0, vat_reporting_period: settings.vat_reporting_period || 'monthly' }
    const { error } = await supabase.from('user_settings').upsert({ user_id: user.id, ...dbSettings }, { onConflict: 'user_id' })
    if (error) { console.error('Supabase error:', error); setStatusMessage('VIRHE: ' + error.message) }
    else { setStatusMessage('ASETUKSET TALLENNETTU!') }
    setIsSettingsSaving(false); setTimeout(() => setStatusMessage(''), 2000)
  }

  if (authLoading) return (<div className="auth-container"><div className="auth-card" style={{ textAlign: 'center' }}><h1 style={{ marginBottom: '8px' }}>📊 Lomake5</h1><p className="subtitle" style={{ marginBottom: '32px' }}>Ladataan...</p><div className="spinner"></div></div></div>)

  if (!user) return (<div className="auth-container"><div className="auth-card"><h1>📊 Lomake5</h1><p className="subtitle">Kirjanpitopalvelut</p><button className="submit-btn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px' }} onClick={async () => { const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } }); if (error) alert(error.message) }}><svg width="20" height="20" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>KIRJAUDU GOOGLE-TILILLÄ</button><p style={{ marginTop: '24px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>JATKAMALLA HYVÄKSYT EHDOT</p></div></div>)

  return (
    <div className="app-layout">
      <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
          <div className="sidebar-header">
            <h2>📊 Lomake5</h2>
            <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
          </div>
        <nav className="sidebar-nav">
          <button className={activeTab === 'ledger' ? 'active' : ''} onClick={() => setActiveTab('ledger')}><span className="nav-text">TAPAHTUMAT</span></button>
          <button className={activeTab === 'reports' ? 'active' : ''} onClick={() => setActiveTab('reports')}><span className="nav-text">VERO</span></button>
          <button className={activeTab === 'invoice' ? 'active' : ''} onClick={() => setActiveTab('invoice')}><span className="nav-text">UUSI LASKU</span></button>
          <button className={activeTab === 'customers' ? 'active' : ''} onClick={() => setActiveTab('customers')}><span className="nav-text">ASIAKKAAT</span></button>
          <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}><span className="nav-text">ASETUKSET</span></button>
        </nav>
        <div className="user-info" style={{ marginTop: 'auto', flexDirection: 'column', alignItems: 'flex-start' }}>
          <span className="user-email">{user.email}</span>
          <button className="sign-out-btn" onClick={() => supabase.auth.signOut()}>Ulos</button>
        </div>
      </aside>

      <main className="main-content">
        {activeTab === 'ledger' && (
          <>
            <div className="ledger-fullscreen">
              <div style={{ display: 'flex', gap: '10px', marginBottom: 16, justifyContent: 'space-between' }}>
                <h2>TAPAHTUMAT</h2>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    className="submit-btn"
                    style={{ width: 'auto' }}
                    onClick={() => { setEditingId(null); cancelEdit(); setShowTositeModal(true); }}
                  >
                    + LISÄÄ UUSI TOSITE
                  </button>
                  <button
                    className="submit-btn"
                    style={{ width: 'auto'}}
                    onClick={() => setShowCsvImportModal(true)}
                  >
                    📄 LATAA .CSV
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <select value={ledgerMonthFilter} onChange={(e) => setLedgerMonthFilter(e.target.value)} style={{ width: 'auto', padding: '8px 12px' }}>
                  <option value="all">Kaikki</option>
                  {(() => { const options = []; const now = new Date(); for (let i = 0; i < 12; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; const label = d.toLocaleDateString('fi-FI', { month: 'long', year: 'numeric' }); options.push({ value, label }) } return options.map(opt => (<option key={opt.value} value={opt.value}>{opt.label}</option>)) })()}
                </select>
              </div>
              <div className="table-container">
                <table className="transactions-table">
                  <thead><tr><th>PÄIVÄMÄÄRÄ</th><th>TYYPPI</th><th>ASIAKAS</th><th>VIITE</th><th>BRUTTO</th><th>ALV %</th><th>NETTO</th><th>TILANNE</th><th>TOIMINNAT</th></tr></thead>
                  <tbody>
                    {filteredTransactions.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <div>{new Date(t.date_issued).toLocaleDateString('fi-FI')}</div>
                          {t.date_paid && t.date_paid !== t.date_issued && (
                            <div
                              style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}
                              title="Maksupäivä"
                            >
                              maksettu {new Date(t.date_paid).toLocaleDateString('fi-FI')}
                            </div>
                          )}
                        </td>
                        <td><span className={`badge ${t.type}`}>{t.type}</span></td>
                        <td title={t.contact_name}>{t.contact_name}</td>
                        <td>
                          {t.reference_number ? (
                            <span
                              title={`Viitenumero ${t.reference_number}`}
                              style={{
                                fontFamily: 'monospace',
                                fontSize: '0.8rem',
                                color: 'var(--text-muted)',
                                padding: '2px 6px',
                                backgroundColor: 'var(--bg-main)',
                                borderRadius: '4px'
                              }}
                            >
                              #{t.reference_number}
                            </span>
                          ) : '—'}
                        </td>
                        <td style={{ fontWeight: '600' }}>{t.amount_gross}</td>
                        <td>{t.tax_rate}%</td>
                        <td>{t.amount_net}</td>
                        <td><span className={`badge ${t.status}`} onClick={() => handleStatusToggle(t)} style={{ cursor: t.type === 'income' ? 'pointer' : 'default' }}>{t.status} {t.date_paid && `(${t.date_paid})`}</span></td>
                        <td>
                          <div className="action-cell">
                            <button onClick={() => handleEditClick(t)} className="edit-btn">MUOKKAA</button>
                            <button onClick={() => handleDelete(t.id)} className="delete-btn">POISTA</button>
                            {(t.receipt_image_url || t.invoice_pdf_url) && (
                              <button onClick={async () => { const url = t.receipt_image_url || t.invoice_pdf_url; if (!url) return; try { const match = url.match(/\/object\/(?:public|sign)\/(receipts|invoices)\/([^?]+)/); if (match) { const bucket = match[1]; const filePath = decodeURIComponent(match[2]); const { data, error } = await supabase.storage.from(bucket).createSignedUrl(filePath, 60); if (error) { window.open(url, '_blank') } else if (data) { window.open(data.signedUrl, '_blank') } } else { window.open(url, '_blank') } } catch (err) { window.open(url, '_blank') } }} className="view-btn">NÄYTÄ</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {activeTab === 'reports' && (
          <div>
            <div className="report-controls" style={{ flexWrap: 'wrap' }}>
              <div className="input-group"><label>Vuosi</label>
                <select value={reportYear} onChange={(e) => setReportYear(e.target.value)}>
                  {availableYears.map(year => (<option key={year} value={year}>{year}</option>))}
                </select>
              </div>
              <div className="input-group"><label>Aikaväli</label>
                <select value={reportPeriodType} onChange={(e) => setReportPeriodType(e.target.value)}>
                  <option value="year">Koko vuosi</option>
                  <option value="quarter">Neljännesvuosi</option>
                  <option value="month">Kuukausi</option>
                </select>
              </div>
              {reportPeriodType === 'quarter' && (
                <div className="input-group"><label>Kvarttaali</label>
                  <select value={selectedQuarter} onChange={(e) => setSelectedQuarter(e.target.value)}>
                    <option value="Q1">Q1 (Tammi-Maalis)</option>
                    <option value="Q2">Q2 (Huhti-Kesä)</option>
                    <option value="Q3">Q3 (Heinä-Syys)</option>
                    <option value="Q4">Q4 (Loka-Joulu)</option>
                  </select>
                </div>
              )}
              {reportPeriodType === 'month' && (
                <div className="input-group"><label>Kuukausi</label>
                  <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)}>
                    <option value="01">Tammikuu</option>
                    <option value="02">Helmikuu</option>
                    <option value="03">Maaliskuu</option>
                    <option value="04">Huhtikuu</option>
                    <option value="05">Toukokuu</option>
                    <option value="06">Kesäkuu</option>
                    <option value="07">Heinäkuu</option>
                    <option value="08">Elokuu</option>
                    <option value="09">Syyskuu</option>
                    <option value="10">Lokakuu</option>
                    <option value="11">Marraskuu</option>
                    <option value="12">Joulukuu</option>
                  </select>
                </div>
              )}
            </div>

            {/* VAROITUS */}
            {partiallyPaidInvoices.length > 0 && (
              <div style={{
                padding: '12px 16px',
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                borderLeft: '4px solid #f59e0b',
                borderRadius: '6px',
                marginBottom: '20px'
              }}>
                <strong>⚠️ Huomio:</strong> {partiallyPaidInvoices.length} lasku(a) on osittain maksettu – osa ALV-ryhmistä on merkitty maksetuksi, osa ei. Tämä vääristää raporttia.
                <ul style={{ marginTop: '8px', marginBottom: 0, paddingLeft: '20px', fontSize: '0.9rem' }}>
                  {partiallyPaidInvoices.map((g, i) => (
                    <li key={i}>
                      Lasku #{g.ref} ({g.customer}) – {g.unpaid.length} rivi(ä) merkitsemättä
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {/*VAROITUS*/}

            {/*  Taloudellinen kuvaaja */}
            <VeroVisuals
              transactions={transactions}
              categories={categories}
              reportYear={reportYear}
              effectivePeriod={effectivePeriod}
            />

            <div className="report-grid">
              <div className="report-card"><h3>Kotimaan myynnit</h3><table className="report-table"><tbody>{Object.entries(reportData.alvSalesTax).filter(([, amount]) => amount > 0).sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).map(([rate, amount]) => (<tr key={rate}><th>{rate} % vero</th><td className="money">{amount.toFixed(2)} €</td></tr>))}</tbody></table></div>
              <div className="report-card"><h3>Vähennettävä vero</h3><table className="report-table"><tbody><tr><th>Verokauden vähennettävä vero</th><td className="money">{reportData.totalVatPaid.toFixed(2)} €</td></tr></tbody></table></div>
              <div className="report-card"><h3>Maksettava vero</h3><table className="report-table"><tbody><tr><th>Maksettava vero</th><td className="money">{reportData.vatToPay.toFixed(2)} €</td></tr></tbody></table></div>
              <div className="report-card"><h3>0-verokannan alainen liikevaihto</h3><table className="report-table"><tbody><tr><th>Liikevaihto yhteensä</th><td className="money">{reportData.zeroTaxSalesNet.toFixed(2)} €</td></tr></tbody></table></div>
              <div className="report-card"><h3>Myynnit ja ostot EU-maihin</h3><table className="report-table"><tbody><tr><th>Tavaramyynnit EU-maihin</th><td className="money">{reportData.euSalesGoods.toFixed(2)} €</td></tr><tr><th>Palvelumyynnit EU-maihin</th><td className="money">{reportData.euSalesServices.toFixed(2)} €</td></tr><tr><th>Tavaraostot EU-maista</th><td className="money">{reportData.euPurchasesGoods.toFixed(2)} €</td></tr><tr><th>Palveluostot EU-maista</th><td className="money">{reportData.euPurchasesServices.toFixed(2)} €</td></tr></tbody></table></div>
              <div className="report-card"><h3>Tavaroiden maahantuonnit</h3><table className="report-table"><tbody><tr><th>Tavaraostot EU:n ulkop.</th><td className="money">{reportData.importGoods.toFixed(2)} €</td></tr></tbody></table></div>
              <div className="report-card"><h3>Käännetty verovelvollisuus</h3><table className="report-table"><tbody><tr><th>Myynnit (rak/palv/metalli)</th><td className="money">{reportData.reverseChargeSales.toFixed(2)} €</td></tr><tr><th>Ostot (rak/palv/metalli)</th><td className="money">{reportData.reverseChargePurchases.toFixed(2)} €</td></tr></tbody></table></div>
              <div className="report-card"><h3>LOMAKE 5 (TULO)</h3><div className="summary-box"><h4>Tulo</h4><div className={`amount ${reportData.profit > 0 ? 'positive' : 'negative'}`}>{reportData.profit.toFixed(2)} €</div></div><table className="report-table"><tbody><tr><th>TULO (NETTO)</th><td className="money">{reportData.totalIncomeNet.toFixed(2)} €</td></tr>{Object.entries(reportData.expensesByCategory).map(([code, amount]) => (<tr key={code}><th>Kulu {code}</th><td className="money">{amount.toFixed(2)} €</td></tr>))}</tbody></table></div>
            </div>
          </div>
        )}

        {activeTab === 'invoice' && (
          <div className="form-card">
            <h2>LUO UUSI LASKU</h2>
            <form onSubmit={handleInvoiceSubmit} className="form-grid">
              <div className="input-group">
                <label>LASKUN NUMERO</label>
                <input type="number" name="invoice_number" value={invoiceData.invoice_number} onChange={handleInvoiceChange} />
              </div>

              <div className="input-group">
                <label>TULON TYYPPI</label>
                <select
                  name="income_category"
                  value={invoiceData.income_category}
                  onChange={(e) => handleIncomeCategoryChange(e.target.value)}
                  required
                >
                  <option value="">-- Valitse --</option>
                  {categories.filter(c => c.type === 'income').map(c => (
                    <option key={c.code} value={c.code}>{c.name_fi}</option>
                  ))}
                </select>
              </div>

              <div className="input-group" style={{ gridColumn: '1 / -1' }}>
                <label>Asiakas</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch', flexWrap: 'wrap' }}>
                  <select
                    value={invoiceData.selectedCustomerId || ''}
                    onChange={(e) => {
                      const customerId = e.target.value
                      const customer = customers.find(c => c.id === customerId)
                      if (customer) {
                        setInvoiceData({
                          ...invoiceData,
                          selectedCustomerId: customer.id,
                          buyer_name: customer.name,
                          buyer_address: customer.address || '',
                          reference_number: customer.reference_number || '',
                          buyer_email: customer.email || ''
                        })
                      } else {
                        setInvoiceData({ ...invoiceData, selectedCustomerId: '', buyer_name: '', buyer_address: '', reference_number: '' })
                      }
                    }}
                    style={{ flex: 1, height: '42px' }}
                  >
                    <option value="">-- Valitse asiakas --</option>
                    {customers.map(c => (<option key={c.id} value={c.id}>{c.name}</option>))}
                  </select>
                  <button type="button" className="submit-btn" style={{ padding: '0 16px', height: '42px', whiteSpace: 'nowrap', marginTop: '0', flexShrink: 0 }} onClick={() => setShowCustomerModal(true)}>+ Lisää uusi asiakas</button>
                </div>
              </div>

              {/* ===== LASKUN RIVIT ===== */}
              <div className="invoice-lines" style={{ gridColumn: '1 / -1' }}>
                <div className="invoice-lines-header">
                  <h3 style={{ margin: 0 }}>LASKUN RIVIT</h3>
                  <button type="button" className="csv-action-btn" onClick={handleAddLine}>+ Lisää rivi</button>
                </div>

                {invoiceData.lines.map((line, i) => {
                  const qty = parseFloat(line.quantity) || 0
                  const price = parseFloat(line.unit_price) || 0
                  const rate = parseFloat(line.tax_rate) || 0
                  const lineNet = qty * price
                  const lineGross = lineNet * (1 + rate / 100)

                  return (
                    <div key={i} className="invoice-line">
                      <input
                        type="text"
                        placeholder="Kuvaus (esim. Työn osuus)"
                        value={line.description}
                        onChange={(e) => handleLineChange(i, 'description', e.target.value)}
                        className="invoice-line-desc"
                      />
                      <input
                        type="number"
                        placeholder="Määrä"
                        value={line.quantity}
                        onChange={(e) => handleLineChange(i, 'quantity', e.target.value)}
                        step="0.01"
                        className="invoice-line-qty"
                      />
                      <input
                        type="number"
                        placeholder="á-hinta €"
                        value={line.unit_price}
                        onChange={(e) => handleLineChange(i, 'unit_price', e.target.value)}
                        step="0.01"
                        className="invoice-line-price"
                      />
                      <select
                        value={line.tax_rate}
                        onChange={(e) => handleLineChange(i, 'tax_rate', e.target.value)}
                        className="invoice-line-vat"
                      >
                        <option value="25.5">25.5%</option>
                        <option value="24">24%</option>
                        <option value="14">14%</option>
                        <option value="13.5">13.5%</option>
                        <option value="10">10%</option>
                        <option value="0">0%</option>
                      </select>
                      <span className="invoice-line-total">{lineGross.toFixed(2)} €</span>
                      <button
                        type="button"
                        className="invoice-line-remove"
                        onClick={() => handleRemoveLine(i)}
                        disabled={invoiceData.lines.length <= 1}
                        title={invoiceData.lines.length <= 1 ? 'Vähintään yksi rivi tarvitaan' : 'Poista rivi'}
                      >
                        ×
                      </button>
                    </div>
                  )
                })}

                {/* Yhteenveto */}
                <div className="invoice-totals">
                  <div className="invoice-totals-row">
                    <span>Yhteensä (alv 0%)</span>
                    <span>{invoiceTotals.netTotal.toFixed(2)} €</span>
                  </div>
                  {Object.entries(invoiceTotals.groups)
                    .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
                    .map(([rate, g]) => (
                      <div key={rate} className="invoice-totals-row">
                        <span>ALV {rate}%</span>
                        <span>{g.tax.toFixed(2)} €</span>
                      </div>
                    ))}
                  <div className="invoice-totals-row total">
                    <span>Maksettava yhteensä</span>
                    <span>{invoiceTotals.grossTotal.toFixed(2)} €</span>
                  </div>
                </div>
              </div>

              <div className="input-group" style={{ gridColumn: '1 / -1' }}>
                <label>HANKKEEN LISÄTIEDOT</label>
                <input type="text" name="project_details" value={invoiceData.project_details} onChange={handleInvoiceChange} />
              </div>

              <div className="input-group" style={{ gridColumn: '1 / -1' }}>
                <label>KULUJEN VIITE (valinnainen)</label>
                <input
                  type="text"
                  name="expense_reference"
                  placeholder="Sama viite kuin kuluilla, jotka liittyvät tähän laskuun"
                  value={invoiceData.expense_reference || ''}
                  onChange={handleInvoiceChange}
                  list="invoice-expense-references"
                />
                <datalist id="invoice-expense-references">
                  {[...new Set(
                    transactions
                      .filter(t => t.type === 'expense' && t.expense_reference)
                      .map(t => t.expense_reference)
                  )].map(ref => (
                    <option key={ref} value={ref} />
                  ))}
                </datalist>
              </div>
              {invoiceData.expense_reference?.trim() && (() => {
                const matchedExpenses = transactions.filter(t =>
                  t.type === 'expense' &&
                  t.expense_reference &&
                  t.expense_reference.trim().toLowerCase() === invoiceData.expense_reference.trim().toLowerCase()
                )
                if (matchedExpenses.length === 0) return null

                const totalNet = matchedExpenses.reduce((s, t) => s + (parseFloat(t.amount_net) || 0), 0)
                const totalGross = matchedExpenses.reduce((s, t) => s + (parseFloat(t.amount_gross) || 0), 0)

                return (
                  <div style={{
                    gridColumn: '1 / -1',
                    padding: '16px',
                    backgroundColor: 'rgba(99, 102, 241, 0.06)',
                    borderLeft: '4px solid #6366f1',
                    borderRadius: '8px',
                    marginTop: '8px'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px' }}>
                      <strong style={{ fontSize: '0.95rem' }}>
                        Viitteellä "{invoiceData.expense_reference}" löytyi {matchedExpenses.length} kulua
                      </strong>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                        {totalNet.toFixed(2)} € (alv 0) · {totalGross.toFixed(2)} € (sis. alv)
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {matchedExpenses.map(exp => (
                        <div key={exp.id} style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr auto auto',
                          gap: '12px',
                          alignItems: 'center',
                          padding: '8px 12px',
                          backgroundColor: 'var(--bg-surface)',
                          borderRadius: '6px',
                          fontSize: '0.85rem'
                        }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <div style={{ fontWeight: 600 }}>{exp.contact_name}</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                              {exp.date_issued?.split('-').reverse().join('.')} · {exp.amount_gross} € · ALV {exp.tax_rate}%
                            </div>
                          </div>
                          <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                            {exp.amount_net} €
                          </span>
                          <button
                            type="button"
                            className="csv-action-btn"
                            onClick={() => {
                              // Lisää kulu laskuriviksi (á-hinta = kulun netto)
                              setInvoiceData(prev => ({
                                ...prev,
                                lines: [
                                  ...prev.lines,
                                  {
                                    description: `${exp.contact_name} (${exp.date_issued})`,
                                    quantity: '1',
                                    unit_price: exp.amount_net?.toString() || '0',
                                    tax_rate: String(exp.tax_rate || 25.5)
                                  }
                                ]
                              }))
                            }}
                            title="Lisää tämä kulu laskuriviksi"
                          >
                            + Lisää laskuriviksi
                          </button>
                        </div>
                      ))}
                    </div>

                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '12px', marginBottom: 0 }}>
                      Vinkki: voit lisätä kulut laskuriveiksi yksi kerrallaan, tai jättää ne pelkäksi viitteeksi.
                      Tieto viitteestä tallennetaan myös laskuun.
                    </p>
                  </div>
                )
              })()}
              <button
                type="submit"
                className="submit-btn"
                disabled={isInvoiceLoading || !isInvoiceFormValid}
                style={{
                  backgroundColor: isInvoiceLoading ? 'var(--primary-blue)' : isInvoiceFormValid ? '#10b981' : '#e5e7eb',
                  color: isInvoiceFormValid ? 'white' : '#9ca3af',
                  border: isInvoiceFormValid ? 'none' : '1px solid #fca5a5',
                  cursor: isInvoiceFormValid ? 'pointer' : 'not-allowed'
                }}
              >
                {isInvoiceLoading ? 'Tallennetaan...' : isInvoiceFormValid ? 'TALLENNA' : 'TÄYTÄ KAIKKI KOHDAT'}
              </button>
            </form>
            {lastInvoiceUrl && (<div style={{ marginTop: '24px', padding: '16px', backgroundColor: 'var(--bg-main)', borderRadius: '8px' }}><p style={{ marginBottom: '12px', fontWeight: 600 }}>✅ Lasku {lastInvoiceNumber} – {settings.company_name || 'Yritys'} luotu!</p><div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}><button onClick={() => { window.open(lastInvoiceUrl, '_blank'); setInvoiceViewed(true) }} className="edit-btn" style={{ flex: 1 }}>📄 Näytä lasku</button><button onClick={() => { const company = settings.company_name || 'Yritys'; const subject = `Lasku ${lastInvoiceNumber} – ${company}`; const body = `Hei,\n\nTässä linkki laskuun:\n${lastInvoiceUrl}\n\nKiitos!`; navigator.clipboard?.writeText(lastInvoiceUrl).catch(() => {}); window.location.href = `mailto:${invoiceData.buyer_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` }} className="edit-btn" style={{ flex: 1, opacity: invoiceViewed ? 1 : 0.5 }} disabled={!invoiceViewed} title={invoiceViewed ? 'Lähetä sähköpostilla' : 'Katso lasku ensin'}>📧 Lähetä sähköpostilla</button></div><p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '8px' }}>Linkki on voimassa 14 päivää.</p></div>)}
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="form-card"><h2>ASETUKSET</h2><form className="form-grid" onSubmit={(e) => e.preventDefault()}>
            <div className="input-group"><label>YRITYKSEN NIMI</label><input type="text" name="company_name" value={settings.company_name || ''} onChange={handleSettingsChange} /></div>
            <div className="input-group"><label>OSOITE</label><input type="text" name="company_address" value={settings.company_address || ''} onChange={handleSettingsChange} /></div>
            <div className="input-group"><label>PUHELIN</label><input type="text" name="company_phone" value={settings.company_phone || ''} onChange={handleSettingsChange} /></div>
            <div className="input-group"><label>SÄHKÖPOSTI</label><input type="email" name="company_email" value={settings.company_email || ''} onChange={handleSettingsChange} /></div>
            <div className="input-group"><label>IBAN</label><input type="text" name="company_iban" value={settings.company_iban || ''} onChange={handleSettingsChange} /></div>
            <div className="input-group"><label>SWIFT</label><input type="text" name="company_swift" value={settings.company_swift || ''} onChange={handleSettingsChange} /></div>
            <div className="input-group"><label>VAT</label><input type="text" name="company_vat" value={settings.company_vat || ''} onChange={handleSettingsChange} /></div>
            <div className="input-group"><label>Y-tunnus</label><input type="text" name="business_id" value={settings.business_id || ''} onChange={handleSettingsChange} /></div>
            <div className="input-group"><label>ALV OLETUS(%)</label><select name="default_tax_rate" value={settings.default_tax_rate || '25.5'} onChange={handleSettingsChange}><option value="25.5">25.5%</option><option value="24">24%</option><option value="14">14%</option><option value="13.5">13.5%</option><option value="10">10%</option><option value="0">0%</option></select></div>
            <div className="input-group"><label>VIIVÄSTYSKORKO(%)</label><input type="text" name="delay_tax_rate" value={settings.delay_tax_rate || ''} onChange={handleSettingsChange} /></div>
            <div className="input-group"><label>LASKUN ALKU</label><input type="text" name="invoice_prefix" value={settings.invoice_prefix || ''} onChange={handleSettingsChange} /></div>
            <button type="button" className="submit-btn" onClick={handleSettingsSave} disabled={isSettingsSaving}>{isSettingsSaving ? 'TALLENNETAAN...' : 'TALLENNA'}</button>
            <button type="button" onClick={handleExportData} className="edit-btn" style={{ flex: 1 }}>📥 LATAA VARMUUSKOPIO</button>
          </form></div>
        )}

        {activeTab === 'customers' && (
          <div className="form-card"><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}><h2>ASIAKKAAT</h2><button className="submit-btn" style={{ padding: '10px 20px', width: 'auto' }} onClick={() => { setEditingCustomer(null); setNewCustomer({ name: '', address: '', y_tunnus: '', email: '', phone: '', reference_number: '' }); setShowCustomerModal(true) }}>+ Lisää uusi asiakas</button></div>
            <div className="table-container"><table className="transactions-table"><thead><tr><th>NIMI</th><th>OSOITE</th><th>Y-TUNNUS</th><th>SÄHKÖPOSTI</th><th>PUHELIN</th><th>VIITENUMERO</th><th>TOIMINNOT</th></tr></thead><tbody>{customers.length === 0 ? (<tr><td colSpan="7" style={{ textAlign: 'center', padding: '20px' }}>Ei asiakkaita. Lisää uusi asiakas.</td></tr>) : (customers.map(customer => (<tr key={customer.id}><td>{customer.name}</td><td style={{ whiteSpace: 'pre-line' }}>{customer.address || '-'}</td><td>{customer.y_tunnus || '-'}</td><td>{customer.email || '-'}</td><td>{customer.phone || '-'}</td><td>{customer.reference_number || '-'}</td><td><div className="action-cell"><button className="edit-btn" onClick={() => { setEditingCustomer(customer); setNewCustomer({ name: customer.name || '', address: customer.address || '', y_tunnus: customer.y_tunnus || '', email: customer.email || '', phone: customer.phone || '', reference_number: customer.reference_number || '' }); setShowCustomerModal(true) }}>Muokkaa</button><button className="delete-btn" onClick={async () => { if (!window.confirm(`Poistetaanko asiakas "${customer.name}"?`)) return; const { error } = await supabase.from('customers').delete().eq('id', customer.id); if (!error) { fetchCustomers(); if (invoiceData.selectedCustomerId === customer.id) { setInvoiceData({ ...invoiceData, selectedCustomerId: '', buyer_name: '', buyer_address: '', reference_number: '' }) } } else { alert('Virhe poistossa: ' + error.message) } }}>Poista</button></div></td></tr>)))}</tbody></table></div></div>
        )}
      </main>
      {showCsvImportModal && (
        <div className="modal-overlay" onClick={handleCsvClose}>
          <div className="modal-content csv-modal" onClick={e => e.stopPropagation()}>
            <h2>PANKKIOTTEEN TUONTI (.CSV)</h2>

            <p style={{ color: 'var(--text-muted)', marginBottom: '16px', fontSize: '0.9rem' }}>
              Valitse pankin CSV-tiedosto. Ohjelma vertailee tapahtumia sovellukseen —{' '}
              <strong>mitään ei muuteta automaattisesti</strong>. Tarkista ehdotukset ja tee muutokset itse.
            </p>

            <label className="scan-btn" style={{ cursor: 'pointer', marginBottom: '16px' }}>
              {csvParsing ? 'Luetaan...' : csvFileName ? `📄 ${csvFileName} — vaihda tiedosto` : '📄 VALITSE CSV-TIEDOSTO'}
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={handleCsvFileUpload}
                disabled={csvParsing}
              />
            </label>

            {csvError && <div className="csv-error">{csvError}</div>}

            {csvComparison && (
              <>
                {csvComparison.dateRange?.minDate && (
                  <div className="csv-daterange">
                    📅 CSV:n aikaväli: <strong>{csvComparison.dateRange.minDate}</strong> –{' '}
                    <strong>{csvComparison.dateRange.maxDate}</strong>
                    {' · '}Vertailu rajattu tähän aikaväliin.
                  </div>
                )}

                <div className="csv-summary">
                  {[
                    { label: 'CSV-rivit', value: csvComparison.results.length, color: '#6b7280' },
                    { label: 'Täsmää', value: csvComparison.results.filter(r => r.type === 'exact').length, color: '#10b981' },
                    { label: 'Nimi eroaa', value: csvComparison.results.filter(r => r.type === 'name_mismatch').length, color: '#f59e0b' },
                    { label: 'Summa eroaa', value: csvComparison.results.filter(r => r.type === 'amount_mismatch').length, color: '#f59e0b' },
                    { label: 'Osittainen', value: csvComparison.results.filter(r => r.type === 'partial').length, color: '#f59e0b' },
                    { label: 'Puuttuu sovelluksesta', value: csvComparison.results.filter(r => r.type === 'missing').length, color: '#ef4444' },
                    { label: 'Vain sovelluksessa', value: csvComparison.unmatchedApp.length, color: '#6366f1' },
                  ].map((s, i) => (
                    <div
                      key={i}
                      className="csv-summary-card"
                      style={{ borderLeft: `3px solid ${s.color}` }}
                    >
                      <div className="label">{s.label}</div>
                      <div className="value" style={{ color: s.color }}>{s.value}</div>
                    </div>
                  ))}
                </div>

                <div style={{ overflowX: 'auto' }}>
                  <table className="csv-table">
                    <thead>
                      <tr>
                        <th>TILA</th>
                        <th>PANKKI</th>
                        <th>SOVELLUS</th>
                        <th>EHDOTETUT TOIMENPITEET</th>
                      </tr>
                    </thead>
                    <tbody>
                      {csvComparison.results.map((r, i) => {
                        const statusMap = {
                          exact: { label: 'TÄSMÄÄ', color: '#10b981' },
                          name_mismatch: { label: 'NIMI EROAA', color: '#f59e0b' },
                          amount_mismatch: { label: 'SUMMA EROAA', color: '#f59e0b' },
                          partial: { label: 'OSITTAINEN', color: '#f59e0b' },
                          missing: { label: 'PUUTTUU', color: '#ef4444' },
                        }
                        const st = statusMap[r.type]
                        const bgColor = r.type === 'exact'
                          ? 'rgba(16, 185, 129, 0.05)'
                          : r.type === 'missing'
                            ? 'rgba(239, 68, 68, 0.05)'
                            : 'rgba(245, 158, 11, 0.05)'

                        return (
                          <tr key={i} style={{ backgroundColor: bgColor }}>
                            <td>
                              <span
                                className="csv-status"
                                style={{ backgroundColor: st.color + '22', color: st.color }}
                              >
                                {st.label}
                              </span>
                            </td>
                            <td>
                              <div style={{ fontWeight: 600 }}>{r.csv.name || '—'}</div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                {r.csv.date} · {r.csv.amount.toFixed(2)} €
                              </div>
                              {r.csv.message && (
                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                  {r.csv.message}
                                </div>
                              )}
                            </td>
                            <td>
                              {r.tx ? (
                                <>
                                  <div style={{ fontWeight: 600 }}>{r.tx.contact_name}</div>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                    {r.tx.date_issued} · {r.tx.amount_gross} € ({r.tx.type})
                                  </div>
                                </>
                              ) : (
                                <span style={{ color: 'var(--text-muted)' }}>— ei vastausta —</span>
                              )}
                            </td>
                            <td>
                              <div className="csv-actions">
                                {r.type === 'exact' && (
                                  <p>✓ Ei toimenpiteitä</p>
                                )}
                                {r.type === 'name_mismatch' && (
                                  <>
                                    <p>Sama päivä ja summa, eri nimi. Tarkista kumpi on oikein.</p>
                                    <button
                                      className="csv-action-btn"
                                      onClick={() => handleCsvUpdateName(r.tx.id, r.csv.name)}
                                    >
                                      Päivitä sovelluksen nimi → "{r.csv.name}"
                                    </button>
                                  </>
                                )}
                                {r.type === 'amount_mismatch' && (
                                  <>
                                    <p>Sama päivä ja nimi, mutta summa eroaa. Tarkista tosite.</p>
                                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                      Pankki: <strong>{Math.abs(r.csv.amount).toFixed(2)} €</strong>
                                      {' · '}
                                      Sovellus: <strong>{r.tx.amount_gross} €</strong>
                                    </p>
                                    <button
                                      className="csv-action-btn"
                                      onClick={() => handleCsvEditTx(r.tx)}
                                    >
                                      Muokkaa tositetta
                                    </button>
                                  </>
                                )}
                                {r.type === 'partial' && (
                                  <>
                                    <p>Vain summa täsmää — varmista, että kyseessä on sama tapahtuma.</p>
                                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                      Pankki: <strong>{r.csv.name || '—'}</strong> {r.csv.date}
                                      <br />
                                      Sovellus: <strong>{r.tx.contact_name}</strong> {r.tx.date_issued}
                                    </p>
                                    <button
                                      className="csv-action-btn"
                                      onClick={() => handleCsvEditTx(r.tx)}
                                    >
                                      Muokkaa tositetta
                                    </button>
                                  </>
                                )}
                                {r.type === 'missing' && (
                                  <>
                                    <p>
                                      Ei löydy sovelluksesta. Ehdotus:{' '}
                                      <strong>{r.csv.amount < 0 ? 'meno' : 'tulo'}</strong>
                                    </p>
                                    <button
                                      className="csv-action-btn create"
                                      onClick={() => handleCsvCreateTx(r.csv)}
                                    >
                                      + Luo uusi tosite
                                    </button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {csvComparison.unmatchedApp.length > 0 && (
                  <div className="csv-unmatched">
                    <h3>Sovelluksessa, mutta ei pankkiotteella ({csvComparison.unmatchedApp.length})</h3>
                    <p className="hint">
                      Tapahtumat, jotka on kirjattu sovellukseen aikavälillä{' '}
                      <strong>{csvComparison.dateRange.minDate} – {csvComparison.dateRange.maxDate}</strong>{' '}
                      mutta joita ei löytynyt CSV-tiedostosta.
                    </p>
                    <div className="csv-unmatched-scroll">
                      <table className="csv-table">
                        <thead>
                          <tr>
                            <th>PÄIVÄ</th>
                            <th>TYYPPI</th>
                            <th>NIMI</th>
                            <th>SUMMA</th>
                            <th>TILANNE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {csvComparison.unmatchedApp.map(t => (
                            <tr key={t.id}>
                              <td>{t.date_issued}</td>
                              <td><span className={`badge ${t.type}`}>{t.type}</span></td>
                              <td>{t.contact_name}</td>
                              <td>{t.amount_gross} €</td>
                              <td><span className={`badge ${t.status}`}>{t.status}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', gap: '10px', marginTop: '24px' }}>
                  <button className="submit-btn" style={{ flex: 1 }} onClick={handleCsvClose}>
                    SULJE
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {showCustomerModal && (
        <div className="modal-overlay" onClick={() => { setShowCustomerModal(false); setEditingCustomer(null); setNewCustomer({ name: '', address: '', y_tunnus: '', email: '', phone: '', reference_number: '' }) }}>
          <div className="modal-content" onClick={e => e.stopPropagation()}><h3>{editingCustomer ? 'MUOKKAA' : 'UUSI ASIAKAS'}</h3>
            <form onSubmit={async (e) => { e.preventDefault(); if (!user) return; let error = null, data = null; if (editingCustomer) { const result = await supabase.from('customers').update({ name: newCustomer.name, address: newCustomer.address, y_tunnus: newCustomer.y_tunnus, email: newCustomer.email, phone: newCustomer.phone, reference_number: newCustomer.reference_number }).eq('id', editingCustomer.id).select(); error = result.error; data = result.data } else { const result = await supabase.from('customers').insert([{ ...newCustomer, user_id: user.id }]).select(); error = result.error; data = result.data } if (!error) { await fetchCustomers(); if (editingCustomer && invoiceData.selectedCustomerId === editingCustomer.id && data?.[0]) { setInvoiceData({ ...invoiceData, buyer_name: data[0].name, buyer_address: data[0].address || '', reference_number: data[0].reference_number || '' }) } setNewCustomer({ name: '', address: '', y_tunnus: '', email: '', phone: '', reference_number: '' }); setEditingCustomer(null); setShowCustomerModal(false) } else { alert('Virhe: ' + error.message) } }}>
              <div className="form-grid">
                <div className="input-group"><label>Nimi *</label><input type="text" value={newCustomer.name} onChange={(e) => setNewCustomer({...newCustomer, name: e.target.value})} required /></div>
                <div className="input-group" style={{ gridColumn: '1 / -1' }}><label>Osoite</label><textarea value={newCustomer.address} onChange={(e) => setNewCustomer({...newCustomer, address: e.target.value})} rows="2" /></div>
                <div className="input-group"><label>Y-tunnus</label><input type="text" value={newCustomer.y_tunnus} onChange={(e) => setNewCustomer({...newCustomer, y_tunnus: e.target.value})} /></div>
                <div className="input-group"><label>Sähköposti</label><input type="email" value={newCustomer.email} onChange={(e) => setNewCustomer({...newCustomer, email: e.target.value})} /></div>
                <div className="input-group"><label>Puhelin</label><input type="text" value={newCustomer.phone} onChange={(e) => setNewCustomer({...newCustomer, phone: e.target.value})} /></div>
                <div className="input-group"><label>Viitenumero</label><input type="text" value={newCustomer.reference_number} onChange={(e) => setNewCustomer({...newCustomer, reference_number: e.target.value})} /></div>
              </div>
              <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}><button type="submit" className="submit-btn" style={{ flex: 1 }}>{editingCustomer ? 'TALLENNA MUUTOKSET' : 'TALLENNA'}</button><button type="button" className="cancel-btn" onClick={() => { setShowCustomerModal(false); setEditingCustomer(null); setNewCustomer({ name: '', address: '', y_tunnus: '', email: '', phone: '', reference_number: '' }) }}>Peruuta</button></div>
            </form>
          </div>
        </div>
      )}

      {showTositeModal && (
        <div className="modal-overlay" onClick={() => setShowTositeModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2>{editingId ? 'MUOKKAA TOSITETTA' : 'LISÄÄ UUSI TOSITE'}</h2>
            {!editingId && (
              <label className="scan-btn" style={{ gridColumn: '1 / -1' }}>
                {isScanning
                  ? 'Skannataan...'
                  : formData.type === 'expense'
                    ? '📷 OTA KUVA KUITISTA'
                    : '📷 SKANNAA TOSITE'}
                <input type="file" accept="image/*,application/pdf" capture="environment" onChange={handleFileUpload} ref={fileInputRef} disabled={isScanning}/>
              </label>
            )}
            <form onSubmit={handleLedgerSubmit} className="form-grid">
              <div className="input-group"><label>TYYPPI</label><select name="type" value={formData.type} onChange={(e) => setFormData({...formData, type: e.target.value})} disabled={editingId}><option value="expense">MENOT</option><option value="income">TULOT</option></select></div>
              <div className="input-group"><label>KATEGORIA</label><select name="category_code" value={String(formData.category_code)} onChange={(e) => { const newCategory = e.target.value; const categoryNum = parseInt(newCategory, 10); const selectedCategory = categories.find(c => c.code === categoryNum); if (selectedCategory && selectedCategory.type === 'income') { const autoTax = INCOME_TAX_RATES[categoryNum] || 25.5; setFormData({ ...formData, category_code: newCategory, tax_rate: String(autoTax) }) } else { setFormData({ ...formData, category_code: newCategory }) } }} required>{categories.filter(c => c.type === formData.type).map(c => (<option key={c.code} value={c.code}>{c.code} - {c.name_fi}</option>))}</select></div>
              <div className="input-group"><label>NIMI</label><input type="text" name="contact_name" value={formData.contact_name} onChange={(e) => setFormData({...formData, contact_name: e.target.value})} required /></div>
              <div className="input-group">
                <label>PÄIVÄMÄÄRÄ</label>
                <input
                  type="date"
                  name="date_issued"
                  value={formData.date_issued}
                  onChange={(e) => setFormData({...formData, date_issued: e.target.value})}
                  required
                  style={isDateSuspicious(formData.date_issued) ? { borderColor: '#f59e0b', borderWidth: '2px' } : {}}
                />
                {isDateSuspicious(formData.date_issued) && (
                  <span style={{ fontSize: '0.8rem', color: '#d97706', fontWeight: 600 }}>
                    ⚠️ Tarkista päivämäärä — vuosi {new Date(formData.date_issued).getFullYear()} poikkeaa kuluvasta vuodesta.
                  </span>
                )}
              </div>
              {formData.type === 'expense' && (
                <div className="input-group" style={{ gridColumn: '1 / -1' }}>
                  <label>VIITE (valinnainen)</label>
                  <input
                    type="text"
                    name="expense_reference"
                    placeholder="Esim. asiakkaan nimi, projektikoodi tai laskunumero"
                    value={formData.expense_reference || ''}
                    onChange={(e) => setFormData({ ...formData, expense_reference: e.target.value })}
                    list="expense-reference-suggestions"
                  />
                  <datalist id="expense-reference-suggestions">
                    {[...new Set(
                      transactions
                        .filter(t => t.type === 'expense' && t.expense_reference)
                        .map(t => t.expense_reference)
                    )].map(ref => (
                      <option key={ref} value={ref} />
                    ))}
                  </datalist>
                  <small style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                    Käytä samaa viitettä laskulla, niin kulut yhdistetään automaattisesti.
                  </small>
                </div>
              )}
              <div className="input-group"><label>YHTEENSÄ(€) (SIS. ALV)</label><input type="number" step="0.01" name="amount_gross" value={formData.amount_gross} onChange={(e) => setFormData({...formData, amount_gross: e.target.value})} required /></div>
              <div className="input-group"><label>ALV (%)</label><select name="tax_rate" value={formData.tax_rate} onChange={(e) => setFormData({...formData, tax_rate: e.target.value})}><option value="25.5">25.5%</option><option value="24">24%</option><option value="14">14%</option><option value="13.5">13.5%</option><option value="10">10%</option><option value="0">0%</option></select></div>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '10px' }}><button type="submit" className="submit-btn" style={{ flex: 1, backgroundColor: editingId ? 'var(--primary-blue)' : '' }}>{editingId ? 'PÄIVITÄ' : 'TALLENNA'}</button>{editingId && <button type="button" onClick={() => { setShowTositeModal(false); cancelEdit() }} className="cancel-btn">PERUUTA</button>}</div>
              {statusMessage && <p className="status-message" style={{ gridColumn: '1 / -1' }}>{statusMessage}</p>}
            </form>
          </div>
        </div>
      )}

      {showTositeConfirm && (() => {
        const gross = parseFloat(formData.amount_gross) || 0
        const rate = parseFloat(formData.tax_rate) || 0
        const net = gross / (1 + rate / 100)
        const vatAmount = gross - net
        const isExpense = formData.type === 'expense'
        const category = categories.find(c => c.code === parseInt(formData.category_code))

        return (
          <div className="modal-overlay" onClick={() => setShowTositeConfirm(false)}>
            <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
              <h2>TARKISTA TIEDOT</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '20px' }}>
                Varmista että tiedot ovat oikein ennen tallennusta. Tämän jälkeen tosite
                näkyy tapahtumalistalla ja Vero-raportissa.
              </p>

              <table style={{ width: '100%', fontSize: '0.95rem', marginBottom: '20px' }}>
                <tbody>
                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '10px 0', color: 'var(--text-muted)' }}>Tyyppi</td>
                    <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: 600 }}>
                      <span className={`badge ${formData.type}`}>{formData.type}</span>
                    </td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '10px 0', color: 'var(--text-muted)' }}>Kategoria</td>
                    <td style={{ padding: '10px 0', textAlign: 'right' }}>
                      {formData.category_code} – {category?.name_fi || '—'}
                    </td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '10px 0', color: 'var(--text-muted)' }}>Nimi</td>
                    <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: 600 }}>
                      {formData.contact_name}
                    </td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '10px 0', color: 'var(--text-muted)' }}>Päivämäärä</td>
                    <td style={{ padding: '10px 0', textAlign: 'right' }}>
                      {formData.date_issued?.split('-').reverse().join('.')}
                    </td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '10px 0', color: 'var(--text-muted)' }}>ALV-kanta</td>
                    <td style={{ padding: '10px 0', textAlign: 'right' }}>{formData.tax_rate} %</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '10px 0', color: 'var(--text-muted)' }}>Netto (ALV 0%)</td>
                    <td style={{ padding: '10px 0', textAlign: 'right', fontFamily: 'monospace' }}>
                      {net.toFixed(2)} €
                    </td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '10px 0', color: 'var(--text-muted)' }}>ALV-osuus</td>
                    <td style={{ padding: '10px 0', textAlign: 'right', fontFamily: 'monospace' }}>
                      {vatAmount.toFixed(2)} €
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: '14px 0 0 0', fontWeight: 700, fontSize: '1.05rem' }}>
                      Brutto yhteensä
                    </td>
                    <td style={{ padding: '14px 0 0 0', textAlign: 'right', fontWeight: 700, fontSize: '1.15rem', fontFamily: 'monospace' }}>
                      {gross.toFixed(2)} €
                    </td>
                  </tr>
                </tbody>
              </table>

              {formData.receipt_url && (
                <p style={{ fontSize: '0.85rem', color: 'var(--success)', marginBottom: '16px' }}>
                  📎 Kuva liitetty tositteeseen
                </p>
              )}

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  className="submit-btn"
                  style={{ flex: 1, backgroundColor: '#10b981' }}
                  onClick={confirmTositeSave}
                >
                  {editingId ? 'VAHVISTA PÄIVITYS' : 'VAHVISTA JA TALLENNA'}
                </button>
                <button
                  type="button"
                  className="cancel-btn"
                  style={{ flex: 1 }}
                  onClick={() => setShowTositeConfirm(false)}
                >
                  TAKAISIN
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {showInvoiceConfirm && (() => {
        const { netTotal, grossTotal, groups } = invoiceTotals

        return (
          <div className="modal-overlay" onClick={() => setShowInvoiceConfirm(false)}>
            <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '620px' }}>
              <h2>TARKISTA LASKU ENNEN TALLENNUSTA</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '20px' }}>
                Lasku tallennetaan ja PDF avautuu uuteen ikkunaan. Tarkista tiedot huolellisesti.
              </p>

              {/* Asiakas */}
              <div style={{ marginBottom: '20px', padding: '12px 16px', backgroundColor: 'var(--bg-main)', borderRadius: '8px' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: '4px' }}>
                  Laskutettava asiakas
                </div>
                <div style={{ fontWeight: 700, fontSize: '1rem' }}>{invoiceData.buyer_name}</div>
                {invoiceData.buyer_address && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', whiteSpace: 'pre-line' }}>
                    {invoiceData.buyer_address}
                  </div>
                )}
              </div>

              {/* Laskun tiedot */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px', fontSize: '0.9rem' }}>
                <div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Laskunumero</div>
                  <div style={{ fontWeight: 600 }}>{invoiceData.invoice_number}</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Päiväys</div>
                  <div style={{ fontWeight: 600 }}>
                    {invoiceData.date_issued?.split('-').reverse().join('.')}
                  </div>
                </div>
              </div>

              {/* Rivit */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: '8px' }}>
                  Laskun rivit ({invoiceData.lines.length})
                </div>
                <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <th style={{ textAlign: 'left', padding: '6px 0', color: 'var(--text-muted)' }}>Kuvaus</th>
                      <th style={{ textAlign: 'right', padding: '6px 0', color: 'var(--text-muted)' }}>Määrä</th>
                      <th style={{ textAlign: 'right', padding: '6px 0', color: 'var(--text-muted)' }}>á-hinta</th>
                      <th style={{ textAlign: 'right', padding: '6px 0', color: 'var(--text-muted)' }}>ALV</th>
                      <th style={{ textAlign: 'right', padding: '6px 0', color: 'var(--text-muted)' }}>Yhteensä</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoiceData.lines.map((l, i) => {
                      const qty = parseFloat(l.quantity) || 0
                      const price = parseFloat(l.unit_price) || 0
                      const rate = parseFloat(l.tax_rate) || 0
                      const lineNet = qty * price
                      const lineGross = lineNet * (1 + rate / 100)
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-color)' }}>
                          <td style={{ padding: '8px 0' }}>{l.description}</td>
                          <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: 'monospace' }}>{qty}</td>
                          <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: 'monospace' }}>{price.toFixed(2)} €</td>
                          <td style={{ padding: '8px 0', textAlign: 'right' }}>{rate}%</td>
                          <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                            {lineGross.toFixed(2)} €
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Yhteenveto */}
              <div style={{ backgroundColor: 'var(--bg-main)', padding: '12px 16px', borderRadius: '8px', marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', marginBottom: '6px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Netto yhteensä</span>
                  <span style={{ fontFamily: 'monospace' }}>{netTotal.toFixed(2)} €</span>
                </div>
                {Object.entries(groups).sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).map(([rate, g]) => (
                  <div key={rate} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', marginBottom: '6px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>ALV {rate}%</span>
                    <span style={{ fontFamily: 'monospace' }}>{g.tax.toFixed(2)} €</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1.1rem', fontWeight: 700, marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed var(--border-color)' }}>
                  <span>Maksettava yhteensä</span>
                  <span style={{ fontFamily: 'monospace' }}>{grossTotal.toFixed(2)} €</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  className="submit-btn"
                  style={{ flex: 1, backgroundColor: '#10b981' }}
                  onClick={confirmInvoiceSave}
                >
                  LUO LASKU
                </button>
                <button
                  type="button"
                  className="cancel-btn"
                  style={{ flex: 1 }}
                  onClick={() => setShowInvoiceConfirm(false)}
                >
                  TAKAISIN
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

export default App