import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from './supabaseClient'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import './App.css'
import Tesseract from 'tesseract.js'
import * as pdfjsLib from 'pdfjs-dist'
pdfjsLib.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;


const DEFAULT_SETTINGS = {
  company_name: '',
  company_address: '',
  company_phone: '',
  company_email: '',
  company_iban: '',
  company_swift: '',
  company_vat: '',
  business_id: '',
  default_tax_rate: '25.5', // Store as string for input field compatibility
  invoice_prefix: 'INV',
  next_invoice_number: '1', // Store as string for input field compatibility
  delay_tax_rate: '11.00', // Store as string
  vat_reporting_period: 'monthly',
};

const DEFAULT_INVOICE_DATA = {
  buyer_name: '',
  buyer_address: '',
  buyer_email: '',
  invoice_number: '1',
  reference_number: '',
  project_details: '',
  description: '',
  quantity: '1',
  unit_price: '0.00',
  tax_rate: '25.5',
  date_issued: new Date().toISOString().split('T')[0],
  income_category: '3001',
  selectedCustomerId: '',
};

const INCOME_TAX_RATES = {
  3001: 25.5,
  3002: 14,
  3003: 10,
  3004: 0,
  3005: 0,      // EU-myynti 0%
  3006: 0,      // Muut maat 0%
  3007: 0,      // Käänteinen vero (ei veroa)
  3008: 13.5,
  3010: 0,      // Tavaramyynnit EU-maihin
  3011: 0,      // Palvelumyynnit EU-maihin
  3100: 0,
  3901: 0,      // Rakentamispalvelun myynnit (käännetty)
  3903: 0,      // Metalliromun myynnit (käännetty)
};

function App() {
  // --- AUTH STATE ---
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)

  // --- APP STATE ---
  const [activeTab, setActiveTab] = useState('ledger')
  const [statusMessage, setStatusMessage] = useState('')
  const [transactions, setTransactions] = useState([])
  const [editingId, setEditingId] = useState(null)

  // --- DATA FROM DB ---
  const [categories, setCategories] = useState([])
  const [customers, setCustomers] = useState([])

  // --- OCR SCANNING ---
  const [isScanning, setIsScanning] = useState(false)
  const fileInputRef = useRef(null)

  // --- REPORTING ---
  const [reportYear, setReportYear] = useState(new Date().getFullYear().toString())
  const [reportPeriodType, setReportPeriodType] = useState('year') // 'year', 'quarter', 'month'
  const [selectedQuarter, setSelectedQuarter] = useState('Q1')
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date()
    return String(now.getMonth() + 1).padStart(2, '0')
  })

  // --- REPORTING MONTH FILTER ---
  const effectivePeriod = useMemo(() => {
    if (reportPeriodType === 'year') return 'all'
    if (reportPeriodType === 'quarter') return selectedQuarter
    if (reportPeriodType === 'month') return selectedMonth
    return 'all'
  }, [reportPeriodType, selectedQuarter, selectedMonth])

  // --- SETTINGS (loaded from DB) ---
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [isSettingsSaving, setIsSettingsSaving] = useState(false)


  // --- INVOICE FORM STATE ---
  const [invoiceData, setInvoiceData] = useState(DEFAULT_INVOICE_DATA);
  const [showCustomerModal, setShowCustomerModal] = useState(false)
  const [isInvoiceLoading, setIsInvoiceLoading] = useState(false)
  const [lastInvoiceUrl, setLastInvoiceUrl] = useState('')
  const [lastInvoiceNumber, setLastInvoiceNumber] = useState('')
  const [invoiceViewed, setInvoiceViewed] = useState(false)
  const [newCustomer, setNewCustomer] = useState({
    name: '',
    address: '',
    y_tunnus: '',
    email: '',
    phone: '',
    reference_number: ''
  })

  const isInvoiceFormValid = useMemo(() => {
  return (
    invoiceData.invoice_number.toString().trim() !== '' &&
    invoiceData.description.trim() !== '' &&
    parseFloat(invoiceData.quantity) > 0 &&
    parseFloat(invoiceData.unit_price) > 0 &&
    invoiceData.income_category !== '' &&
    invoiceData.selectedCustomerId !== ''
  )
}, [invoiceData])

  // --- LEDGER FORM STATE ---
  const [formData, setFormData] = useState({
    type: 'expense',
    category_code: 346,
    contact_name: '',
    date_issued: new Date().toISOString().split('T')[0],
    amount_gross: '',
    tax_rate: 25.5,
    y_tunnus: '',
    receipt_url: null,
  })

  // --- LEDGER MONTH FILTER ---
  const [ledgerMonthFilter, setLedgerMonthFilter] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  const filteredTransactions = useMemo(() => {
    if (ledgerMonthFilter === 'all') {
      return transactions
    }
    return transactions.filter(t => {
      const dateStr = t.date_issued // YYYY-MM-DD
      return dateStr && dateStr.startsWith(ledgerMonthFilter)
    })
  }, [transactions, ledgerMonthFilter])

  // -- CUSTOMER EDITING STATE ---
  const [editingCustomer, setEditingCustomer] = useState(null) // null = adding new, object = editing

  const handleExportData = async () => {
  const { data: transactions } = await supabase.from('transactions').select('*')
  const { data: customers } = await supabase.from('customers').select('*')
  const { data: merchants } = await supabase.from('merchants').select('*')
  const { data: settings } = await supabase.from('user_settings').select('*')
  
  // -- EXPORT DATA --
  const exportData = {
    exported_at: new Date().toISOString(),
    transactions,
    customers,
    merchants,
    settings
  }

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `lomake5_backup_${new Date().toISOString().split('T')[0]}.json`
  a.click()
  URL.revokeObjectURL(url)
}

  // =============================================
  // 1. AUTHENTICATION & INITIAL DATA LOAD
  // =============================================
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

    // Listen for auth changes
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
    const { data, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle(); // Use maybeSingle to avoid errors if no row exists

    if (error) {
      console.error("Failed to load settings:", error);
      return;
    }

    if (data) {
      // Merge loaded data with defaults to ensure all fields are defined
      const mergedSettings = { ...DEFAULT_SETTINGS, ...data };
      // Convert numeric fields back to strings for the form inputs
      setSettings({
        ...mergedSettings,
        default_tax_rate: String(mergedSettings.default_tax_rate),
        next_invoice_number: String(mergedSettings.next_invoice_number),
        delay_tax_rate: String(mergedSettings.delay_tax_rate),
      });
      // Update invoice number in form state
      setInvoiceData(prev => ({
        ...prev,
        invoice_number: String(mergedSettings.next_invoice_number)
      }));
    } else {
      // If no settings exist in DB, create them with defaults
      await supabase.from('user_settings').insert({ user_id: userId, ...DEFAULT_SETTINGS });
    }
  }

  const saveSettings = async (updatedSettings) => {
    if (!user) return
    await supabase
      .from('user_settings')
      .update(updatedSettings)
      .eq('user_id', user.id)
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
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .order('date_issued', { ascending: false })
    if (data) setTransactions(data)
  }

  const resetInvoiceForm = (nextInvoiceNumber) => {
    setInvoiceData({
      ...DEFAULT_INVOICE_DATA,
      invoice_number: nextInvoiceNumber.toString(),
      date_issued: new Date().toISOString().split('T')[0],
    })

  }

  // =============================================
  // 2. RECEIPT SCANNING (Secure Edge Function)
  // =============================================
  
  const handleFileUpload = async (e) => {
    const file = e.target.files[0]
    if (!file || !user) return

    setIsScanning(true)
    setStatusMessage('KÄSITTELEN...')

    // Optional: Image preprocessing for better OCR (same as before)
    const preprocessImage = (file) => {
      return new Promise((resolve) => {
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
    }

    try {
      let text = ''

      if (file.type === 'application/pdf') {
        // --- PDF Processing ---
        setStatusMessage('KÄSITTELEN...')
        const arrayBuffer = await file.arrayBuffer()
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
        const page = await pdf.getPage(1) // First page only
        const viewport = page.getViewport({ scale: 2.0 }) // High resolution

        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        canvas.width = viewport.width
        canvas.height = viewport.height

        await page.render({ canvasContext: context, viewport }).promise

        // Convert canvas to blob for Tesseract
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        
        setStatusMessage('TUNNISTAN TEKSTIÄ...')
        const { data } = await Tesseract.recognize(
          blob,
          'fin+eng',
          {
            logger: m => {
              if (m.status === 'recognizing text') {
                setStatusMessage(`TUNNISTAN TEKSTIÄ... ${Math.round(m.progress * 100)}%`)
              }
            }
          }
        )
        text = data.text
      } else {
        // --- Image Processing ---
        setStatusMessage('KÄSITTELEN...')
        const processedFile = await preprocessImage(file)
        
        setStatusMessage('TUNNISTAN TEKSTIÄ...')
        const { data } = await Tesseract.recognize(
          processedFile,
          'fin+eng',
          {
            logger: m => {
              if (m.status === 'recognizing text') {
                setStatusMessage(`TUNNISTAN TEKSTIÄ... ${Math.round(m.progress * 100)}%`)
              }
            }
          }
        )
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
        // Calculate new dimensions while maintaining aspect ratio
        let width = img.width
        let height = img.height
        
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

        // Convert to blob with reduced quality
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(img.src)
          resolve(blob)
        }, 'image/jpeg', quality)
      }
    })
  }

  const parseReceiptText = async (text, imageFile) => {
    let newDate = formData.date_issued
    let newAmount = formData.amount_gross
    let newTax = formData.tax_rate
    let newContact = formData.contact_name
    let newCategory = formData.category_code
    let detectedYTunnus = ''

    // 1. Extract Y-tunnus
    const yRegex = /\b\d{7}-\d\b/
    const yMatch = text.match(yRegex)
    if (yMatch) {
      detectedYTunnus = yMatch[0]
      // Look up in merchants table
      const { data: merchant } = await supabase
        .from('merchants')
        .select('*')
        .eq('y_tunnus', detectedYTunnus)
        .eq('user_id', user.id)
        .single()
      if (merchant) {
        newContact = merchant.name
        newCategory = merchant.default_category_code
      }
    }

    // 2. Extract merchant name (fallback)
    if (!newContact) {
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2)
      const blacklist = ['kuitti', 'tervetuloa', 'pvm', 'fax', 'tel', 'puh', 'käteiskuitti']
      const cleanLines = lines.filter(l => !blacklist.some(b => l.toLowerCase().includes(b)))
      newContact = cleanLines[0] || ''
    }

    // 3. Extract amount (largest numeric value that isn't tax rate)
    const amountRegex = /\b\d{1,4}[.,]\d{2}\b/g
    const amounts = text.match(amountRegex)
    if (amounts) {
      const numericAmounts = amounts.map(a => parseFloat(a.replace(',', '.')))
      const filtered = numericAmounts.filter(a => a !== 25.5 && a !== 24 && a !== 14 && a !== 10)
      if (filtered.length > 0) newAmount = Math.max(...filtered).toFixed(2)
    }

    // 4. Extract date
    const dateRegex = /(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{2,4})/g
    const dates = [...text.matchAll(dateRegex)]
    if (dates.length > 0) {
      let [_, d, m, y] = dates[0]
      if (y.length === 2) y = '20' + y
      newDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    }

    // 5. Upload receipt image to storage
    let receiptUrl = null
    if (imageFile) {
      try {
        let fileToUpload = imageFile

        // Compress if it's an image (not PDF)
        if (imageFile.type.startsWith('image/')) {
          setStatusMessage('TALLENNAN...')
          const compressedBlob = await compressImage(imageFile, 1200, 1200, 0.7)
          fileToUpload = new File([compressedBlob], imageFile.name.replace(/\.[^/.]+$/, '.jpg'), { type: 'image/jpeg' })
        }

        const fileExt = fileToUpload.name.split('.').pop()
        const fileName = `${user.id}/${Date.now()}_receipt.${fileExt}`
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('receipts')
          .upload(fileName, fileToUpload)

        if (!uploadError) {
          const { data: { publicUrl } } = supabase.storage.from('receipts').getPublicUrl(fileName)
          receiptUrl = publicUrl
        }
      } catch (err) {
        console.warn('Image compression/upload failed:', err)
      }
    }

    setFormData(prev => ({
      ...prev,
      contact_name: newContact,
      date_issued: newDate,
      amount_gross: newAmount,
      tax_rate: newTax,
      category_code: newCategory,
      y_tunnus: detectedYTunnus,
      receipt_url: receiptUrl // we'll add this field temporarily
    }))
  }

  // =============================================
  // 3. LEDGER SUBMIT (CREATE / UPDATE)
  // =============================================
  const handleLedgerSubmit = async (e) => {
    e.preventDefault()
    if (!user) return

    setStatusMessage(editingId ? 'Updating...' : 'Saving...')

    const gross = parseFloat(formData.amount_gross)
    const taxMultiplier = 1 + (parseFloat(formData.tax_rate) / 100)
    const net = gross / taxMultiplier

    const isExpense = formData.type === 'expense'

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
      receipt_image_url: formData.receipt_url || null
    }

    let dbError
    if (editingId) {
      const { error } = await supabase
        .from('transactions')
        .update(payload)
        .eq('id', editingId)
      dbError = error
    } else {
      const { error } = await supabase
        .from('transactions')
        .insert([payload])
      dbError = error

      // Save merchant memory for expenses
      if (!error && isExpense && formData.y_tunnus) {
        await supabase.from('merchants').upsert({
          user_id: user.id,
          y_tunnus: formData.y_tunnus,
          name: formData.contact_name,
          default_category_code: parseInt(formData.category_code)
        }, { onConflict: 'user_id, y_tunnus' })
      }
    }

    if (!dbError) {
      setStatusMessage('VALMIS!')
      cancelEdit()
      fetchTransactions()
    } else {
      setStatusMessage('Database Error: ' + dbError.message)
    }
    setTimeout(() => setStatusMessage(''), 3000)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setFormData({
      type: 'expense',
      category_code: 346,
      contact_name: '',
      date_issued: new Date().toISOString().split('T')[0],
      amount_gross: '',
      tax_rate: settings.default_tax_rate || 25.5,
      y_tunnus: '',
      receipt_url: null
    })
  }

  const handleEditClick = (t) => {
    setEditingId(t.id)
    setFormData({
      type: t.type,
      category_code: t.category_code,
      contact_name: t.contact_name,
      date_issued: t.date_issued,
      amount_gross: t.amount_gross,
      tax_rate: String(t.tax_rate),
      y_tunnus: '',
      receipt_url: t.receipt_image_url
    })
    setActiveTab('ledger')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleDelete = async (id) => {
    if (!window.confirm("Poistetaanko tapahtuma?")) return

    // First, fetch the transaction to get the file URL
    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('receipt_image_url, invoice_pdf_url')
      .eq('id', id)
      .single()

    if (fetchError) {
      alert('Virhe haettaessa tietoja: ' + fetchError.message)
      return
    }

    // Delete the transaction record
    const { error: deleteError } = await supabase
      .from('transactions')
      .delete()
      .eq('id', id)

    if (deleteError) {
      alert('Virhe poistettaessa: ' + deleteError.message)
      return
    }

    // If there's an associated file, delete it from storage
    const fileUrl = transaction?.receipt_image_url || transaction?.invoice_pdf_url;
    if (fileUrl) {
      try {
        let bucket = '';
        let path = '';
        // Käsittele sekä julkiset että allekirjoitetut URL:t
        if (fileUrl.includes('/receipts/')) {
          bucket = 'receipts';
          const match = fileUrl.match(/\/receipts\/([^?]+)/);
          if (match) path = decodeURIComponent(match[1]);
        } else if (fileUrl.includes('/invoices/')) {
          bucket = 'invoices';
          const match = fileUrl.match(/\/invoices\/([^?]+)/);
          if (match) path = decodeURIComponent(match[1]);
        }
        if (bucket && path) {
          await supabase.storage.from(bucket).remove([path]);
        }
      } catch (err) {
        console.warn('File deletion warning:', err);
      }
    }

    fetchTransactions()
  }

  const handleStatusToggle = async (t) => {
    if (t.type === 'expense') {
      alert('Kuitit merkataan aina maksetuksi')
      return
    }

    if (t.status === 'unpaid') {
      const today = new Date().toISOString().split('T')[0]
      const paymentDate = window.prompt("Syötä maksupäivä (YYYY-MM-DD):", today)
      if (paymentDate) {
        await supabase
          .from('transactions')
          .update({ status: 'paid', date_paid: paymentDate })
          .eq('id', t.id)
        fetchTransactions()
      }
    } else {
      if (window.confirm("Merkitäänkö maksamattomaksi?")) {
        await supabase
          .from('transactions')
          .update({ status: 'unpaid', date_paid: null })
          .eq('id', t.id)
        fetchTransactions()
      }
    }
  }

  // =============================================
  // 4. INVOICE GENERATION
  // =============================================
  // Määritä verokannat tulokategorioille
  const incomeTaxRates = {
    3001: 25.5,
    3002: 14,
    3003: 10,
    3004: 0,
    3005: 0,
    3006: 0,
    3007: 0,
    3008: 13.5,
    3100: 0, 
    // lisää muita tarpeen mukaan
  }


  const handleInvoiceChange = (e) => {
    setInvoiceData({ ...invoiceData, [e.target.name]: e.target.value })
    // If user starts editing, remove the old success state
    if (lastInvoiceUrl) {
      setLastInvoiceUrl('')
      setLastInvoiceNumber('')
      setInvoiceViewed(false)
    }
  }

  const handleInvoiceSubmit = async (e) => {
    e.preventDefault()
    if (!user) return
    setIsInvoiceLoading(true)
    setStatusMessage('LUON LASKUA...')
    
    try {
      const qty = parseFloat(invoiceData.quantity)
      const price = parseFloat(invoiceData.unit_price)
      const net = qty * price
      const taxRate = parseFloat(invoiceData.tax_rate)
      const taxAmount = net * (taxRate / 100)
      const gross = net + taxAmount

      const issueDate = new Date(invoiceData.date_issued)
      const dueDate = new Date(issueDate)
      dueDate.setDate(dueDate.getDate() + 14)
      const formattedDueDate = dueDate.toISOString().split('T')[0]

      // --- Generate PDF ---
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

      const doc = new jsPDF()
      doc.setFontSize(22)
      doc.setFont(undefined, 'bold')
      doc.text(safeSettings.company_name, 14, 20)
      doc.text('LASKU', 196, 20, { align: 'right' })
      doc.setFontSize(12)
      doc.setFont(undefined, 'normal')
      doc.text(invoiceData.buyer_name || 'Asiakas', 14, 35)

      const buyerAddress = invoiceData.buyer_address || ''
      doc.text(doc.splitTextToSize(buyerAddress, 80), 14, 41)

      autoTable(doc, {
        startY: 28,
        margin: { left: 120 },
        theme: 'plain',
        body: [
          ['Laskun numero', invoiceData.invoice_number || ''],
          ['Laskun päiväys', invoiceData.date_issued || ''],
          ['Maksuehto', '14 päivää'],
          ['Eräpäivä', formattedDueDate || ''],
          ['Viivästyskorko', safeSettings.delay_tax_rate + '%'],
          ['Viitenumero', invoiceData.reference_number || '']
        ],
        styles: { fontSize: 10, cellPadding: 1 },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 40 } }
      })

      autoTable(doc, {
        startY: Math.max(doc.lastAutoTable.finalY + 10, 65),
        head: [['Kuvaus', 'Määrä', 'á-hinta', 'Yhteensä']],
        body: [[
          invoiceData.description || '',
          qty || 0,
          price.toFixed(2) + '€',
          net.toFixed(2) + '€'
        ]],
        theme: 'grid',
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0] },
        styles: { fontSize: 10 }
      })

      const finalY = doc.lastAutoTable.finalY
      doc.setFontSize(10)
      doc.setFont(undefined, 'bold')
      doc.text('Hankkeen tiedot', 14, finalY + 10)
      doc.setFont(undefined, 'normal')
      doc.text(invoiceData.project_details || '', 14, finalY + 16)

      autoTable(doc, {
        startY: finalY + 10,
        margin: { left: 120 },
        theme: 'plain',
        body: [
          ['Yhteensä (alv 0%)', net.toFixed(2) + '€'],
          [`${taxRate.toFixed(2)}% ALV`, taxAmount.toFixed(2) + '€'],
          ['Maksettava yhteensä', gross.toFixed(2) + '€']
        ],
        styles: { fontSize: 10, cellPadding: 1.5 },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 40 }, 1: { halign: 'right' } }
      })

      const footerY = 270
      doc.setFontSize(8)
      doc.setTextColor(100, 100, 100)
      doc.text(`${safeSettings.company_name} | ${safeSettings.company_address}`, 105, footerY, { align: 'center' })
      doc.text(`Puh: ${safeSettings.company_phone} | Email: ${safeSettings.company_email}`, 105, footerY + 5, { align: 'center' })
      doc.text(`IBAN: ${safeSettings.company_iban} | SWIFT: ${safeSettings.company_swift}`, 105, footerY + 10, { align: 'center' })
      doc.text(`Y-tunnus: ${safeSettings.business_id} | ALV-nro: ${safeSettings.company_vat}`, 105, footerY + 15, { align: 'center' })

      // --- Upload PDF to Supabase Storage ---
      const pdfBlob = doc.output('blob')
      const pdfFileName = `${user.id}/invoice_${invoiceData.invoice_number}_${Date.now()}.pdf`

      const { error: uploadError } = await supabase.storage
        .from('invoices')
        .upload(pdfFileName, pdfBlob, {
          contentType: 'application/pdf',
          cacheControl: '3600'
        })

      let pdfUrl = null
      if (!uploadError) {
        const { data: signedData, error: signedError } = await supabase.storage
          .from('invoices')
          .createSignedUrl(pdfFileName, 1209600) // 14 days

        if (!signedError) {
          pdfUrl = signedData.signedUrl
          // ✅ Set state AFTER pdfUrl has the real URL
          setLastInvoiceUrl(pdfUrl)
          setLastInvoiceNumber(invoiceData.invoice_number)
        } else {
          console.error('Signed URL error:', signedError)
        }
      } else {
        console.error('Upload error:', uploadError)
      }

      // --- Save transaction to DB ---
      const { error: dbError } = await supabase.from('transactions').insert([{
        user_id: user.id,
        type: 'income',
        category_code: parseInt(invoiceData.income_category),
        contact_name: invoiceData.buyer_name,
        date_issued: invoiceData.date_issued,
        due_date: formattedDueDate,
        amount_gross: gross,
        tax_rate: taxRate,
        amount_net: net,
        status: 'unpaid',
        description: invoiceData.description,
        invoice_pdf_url: pdfUrl
      }])

      // --- Save customer to memory ---
      await supabase.from('customers').upsert({
        user_id: user.id,
        name: invoiceData.buyer_name,
        address: invoiceData.buyer_address,
        reference_number: invoiceData.reference_number
      }, { onConflict: 'user_id, name' })

      // --- Increment invoice number and save to settings ---
      const nextNum = parseInt(invoiceData.invoice_number) + 1
      await saveSettings({ next_invoice_number: nextNum })
      resetInvoiceForm(nextNum)

      // --- Open PDF in new tab ---
      if (pdfUrl) {
        window.open(pdfUrl, '_blank')
      }

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

  // =============================================
  // 5. REPORTING LOGIC (Cash Basis)
  // =============================================

const reportData = useMemo(() => {
  let totalVatCollected = 0;
  let totalVatPaid = 0;
  let totalIncomeNet = 0;
  let totalExpenseNet = 0;
  const alvSalesTax = {};
  let zeroTaxSalesNet = 0;
  const expensesByCategory = {};

  // Uudet kentät
  let euSalesGoods = 0;        // Tavaramyynnit EU-maihin (netto)
  let euSalesServices = 0;     // Palvelumyynnit EU-maihin (netto)
  let euPurchasesGoods = 0;    // Tavaraostot EU-maista (netto)
  let euPurchasesServices = 0; // Palveluostot EU-maista (netto)
  let importGoods = 0;         // Tavaroiden maahantuonti EU:n ulkop.
  let reverseChargeSales = 0;  // Käännetyn verovelvollisuuden myynnit
  let reverseChargePurchases = 0; // Käännetyn verovelvollisuuden ostot

  transactions.forEach(t => {
    const accountingDateStr = (t.status === 'paid' && t.date_paid) ? t.date_paid : t.date_issued;
    const date = new Date(accountingDateStr);
    if (date.getFullYear().toString() !== reportYear) return;

    if (effectivePeriod !== 'all') {
      const month = date.getMonth() + 1;
      if (effectivePeriod.startsWith('Q')) {
        const q = parseInt(effectivePeriod[1]);
        if (q === 1 && month > 3) return;
        if (q === 2 && (month < 4 || month > 6)) return;
        if (q === 3 && (month < 7 || month > 9)) return;
        if (q === 4 && month < 10) return;
      } else {
        if (month.toString().padStart(2, '0') !== effectivePeriod) return;
      }
    }

    const net = parseFloat(t.amount_net);
    const gross = parseFloat(t.amount_gross);
    const vatAmount = gross - net;
    const code = t.category_code;

    if (t.type === 'income' && t.status === 'paid') {
      if (code === 3004 || code === 3005 || code === 3006 || code === 3010 || code === 3011) {
        zeroTaxSalesNet += net;
      }
      if (code === 3010) euSalesGoods += net;           // Tavaramyynnit EU
      if (code === 3011) euSalesServices += net;        // Palvelumyynnit EU
      if (code === 3901 || code === 3903) reverseChargeSales += net; // Käännetty myynti
      totalVatCollected += vatAmount;
      totalIncomeNet += net;
      if (t.tax_rate === 0) {
        // jo laskettiin zeroTaxSalesNet
      } else {
        const key = t.tax_rate.toString();
        if (!alvSalesTax[key]) alvSalesTax[key] = 0;
        alvSalesTax[key] += vatAmount;
      }
    } else if (t.type === 'expense') {
      totalVatPaid += vatAmount;
      totalExpenseNet += net;
      if (!expensesByCategory[code]) expensesByCategory[code] = 0;
      expensesByCategory[code] += net;

      // EU-ostot ja maahantuonnit
      if (code === 3701) euPurchasesGoods += net;
      if (code === 3702) euPurchasesServices += net;
      if (code === 3801) importGoods += net;
      if (code === 3902 || code === 3904) reverseChargePurchases += net;
    }
  });

  return {
    vatToPay: totalVatCollected - totalVatPaid,
    totalVatCollected,
    totalVatPaid,
    totalIncomeNet,
    totalExpenseNet,
    profit: totalIncomeNet - totalExpenseNet,
    alvSalesTax,
    zeroTaxSalesNet,
    expensesByCategory,
    // Uudet palautettavat kentät
    euSalesGoods,
    euSalesServices,
    euPurchasesGoods,
    euPurchasesServices,
    importGoods,
    reverseChargeSales,
    reverseChargePurchases,
  };
}, [transactions, reportYear, effectivePeriod]);

  const availableYears = useMemo(() => {
    const years = new Set()
    const currentYear = new Date().getFullYear()
    
    transactions.forEach(t => {
      // Use the accounting date (cash basis)
      const dateStr = (t.status === 'paid' && t.date_paid) ? t.date_paid : t.date_issued
      if (dateStr) {
        const year = new Date(dateStr).getFullYear()
        if (!isNaN(year)) years.add(year)
      }
    })
    
    // Always include current year even if no transactions yet
    years.add(currentYear)
    
    // Convert to array, sort descending (most recent first)
    return Array.from(years).sort((a, b) => b - a)
  }, [transactions])

  useEffect(() => {
    if (availableYears.length > 0 && !availableYears.includes(parseInt(reportYear))) {
      setReportYear(availableYears[0].toString())
    }
  }, [availableYears, reportYear])

  // =============================================
  // 6. SETTINGS HANDLING
  // =============================================
  const handleSettingsChange = (e) => {
    const { name, value } = e.target;
    setSettings(prev => ({ ...prev, [name]: value || '' }));
  }

  const handleSettingsSave = async () => {
    console.log('=== handleSettingsSave START ===')
    if (!user) {
      console.log('No user, aborting')
      return
    }

    setIsSettingsSaving(true)
    setStatusMessage('TALLENNETAAN ASETUKSIA...')

    const dbSettings = {
      company_name: settings.company_name || '',
      company_address: settings.company_address || '',
      company_phone: settings.company_phone || '',
      company_email: settings.company_email || '',
      company_iban: settings.company_iban || '',
      company_swift: settings.company_swift || '',
      company_vat: settings.company_vat || '',
      business_id: settings.business_id || '',
      default_tax_rate: parseFloat(settings.default_tax_rate) || 25.5,
      invoice_prefix: settings.invoice_prefix || 'INV',
      next_invoice_number: parseInt(settings.next_invoice_number) || 1,
      delay_tax_rate: parseFloat(settings.delay_tax_rate) || 11.0,
      vat_reporting_period: settings.vat_reporting_period || 'monthly',
    }

    console.log('Payload:', { user_id: user.id, ...dbSettings })

    const { error } = await supabase
      .from('user_settings')
      .upsert({ user_id: user.id, ...dbSettings }, { onConflict: 'user_id' })

    if (error) {
      console.error('Supabase error:', error)
      setStatusMessage('VIRHE: ' + error.message)
    } else {
      console.log('Settings saved successfully')
      setStatusMessage('ASETUKSET TALLENNETTU!')
    }

    setIsSettingsSaving(false)
    setTimeout(() => setStatusMessage(''), 2000)
  }

  // =============================================
  // 7. RENDER
  // =============================================
  if (authLoading) {
    return (
      <div className="auth-container">
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <h1 style={{ marginBottom: '8px' }}>📊 Lomake5</h1>
          <p className="subtitle" style={{ marginBottom: '32px' }}>Ladataan...</p>
          <div className="spinner"></div>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <h1>📊 Lomake5</h1>
          <p className="subtitle">Kirjanpitopalvelut</p>
          
          <button
            className="submit-btn"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px' }}
            onClick={async () => {
              const { error } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                  redirectTo: window.location.origin // redirect back to app after login
                }
              })
              if (error) alert(error.message)
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            KIRJAUDU GOOGLE-TILILLÄ
          </button>
          
          <p style={{ marginTop: '24px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            JATKAMALLA HYVÄKSYT EHDOT
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-container">
      <div className="app-header">
        <h2>📊 Lomake5</h2>
        <div className="user-info">
          <span className="user-email">{user.email}</span>
          <button className="sign-out-btn" onClick={() => supabase.auth.signOut()}>
            KIRJAUDU ULOS
          </button>
        </div>
      </div>

      <div className="tabs" style={{ WebkitOverflowScrolling: 'touch' }}>
        <button className={`tab-btn ${activeTab === 'ledger' ? 'active' : ''}`} onClick={() => setActiveTab('ledger')}>TOSITTEET</button>
        <button className={`tab-btn ${activeTab === 'reports' ? 'active' : ''}`} onClick={() => setActiveTab('reports')}>VERO</button>
        <button className={`tab-btn ${activeTab === 'invoice' ? 'active' : ''}`} onClick={() => setActiveTab('invoice')}>UUSI LASKU</button>
        <button className={`tab-btn ${activeTab === 'customers' ? 'active' : ''}`} onClick={() => setActiveTab('customers')}>ASIAKKAAT</button>
        <button className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>ASETUKSET</button>
      </div>

      {/* LEDGER TAB */}
      {activeTab === 'ledger' && (
        <>
        <div className="form-card" style={{ border: editingId ? '2px solid var(--primary-blue)' : '1px solid var(--border-color)' }}>
          <h2>{editingId ? 'MUOKKAA' : 'LISÄÄ UUSI TOSITE'}</h2>
          {!editingId && formData.type === 'expense' && (
            <label className="scan-btn">
              {isScanning ? 'Scanning...' : '📷 OTA KUVA KUITISTA'}
              <input type="file" accept="image/*,application/pdf" capture="environment" onChange={handleFileUpload} ref={fileInputRef} disabled={isScanning}/>
            </label>
          )}
          <form onSubmit={handleLedgerSubmit} className="form-grid">
            <div className="input-group">
              <label>TYYPPI</label>
              <select name="type" value={formData.type} onChange={(e) => setFormData({...formData, type: e.target.value})} disabled={editingId}>
                <option value="expense">MENOT</option>
                <option value="income">TULOT</option>
              </select>
            </div>
            <div className="input-group">
              <label>KATEGORIA</label>
              <select
                name="category_code"
                value={String(formData.category_code)}  // varmistetaan merkkijono
                onChange={(e) => {
                  const newCategory = e.target.value;   // esim. "3001"
                  const categoryNum = parseInt(newCategory, 10);
                  const selectedCategory = categories.find(c => c.code === categoryNum);
                  if (selectedCategory && selectedCategory.type === 'income') {
                    // Automaattinen verokanta tulokategorioille
                    const autoTax = INCOME_TAX_RATES[categoryNum] || 25.5;
                    setFormData({
                      ...formData,
                      category_code: newCategory,
                      tax_rate: String(autoTax)
                    });
                  } else {
                    // Menoille tai tuntemattomille vain kategoria päivittyy
                    setFormData({ ...formData, category_code: newCategory });
                  }
                }}
                required
              >
                {categories
                  .filter(c => c.type === formData.type)
                  .map(c => (
                    <option key={c.code} value={c.code}>{c.code} - {c.name_fi}</option>
                  ))
                }
              </select>
            </div>
            <div className="input-group">
              <label>NIMI</label>
              <input type="text" name="contact_name" value={formData.contact_name} onChange={(e) => setFormData({...formData, contact_name: e.target.value})} required />
            </div>
            <div className="input-group">
              <label>PÄIVÄMÄÄRÄ</label>
              <input type="date" name="date_issued" value={formData.date_issued} onChange={(e) => setFormData({...formData, date_issued: e.target.value})} required />
            </div>
            <div className="input-group">
              <label>YHTEENSÄ(€) (SIS. ALV)</label>
              <input type="number" step="0.01" name="amount_gross" value={formData.amount_gross} onChange={(e) => setFormData({...formData, amount_gross: e.target.value})} required />
            </div>
            <div className="input-group">
              <label>ALV (%)</label>
              <select name="tax_rate" value={formData.tax_rate} onChange={(e) => setFormData({...formData, tax_rate: e.target.value})}>
                <option value="25.5">25.5%</option>
                <option value="24">24%</option>
                <option value="14">14%</option>
                <option value="13.5">13.5%</option>
                <option value="10">10%</option>
                <option value="0">0%</option>
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '10px' }}>
              <button type="submit" className="submit-btn" style={{ flex: 1, backgroundColor: editingId ? 'var(--primary-blue)' : '' }}>
                {editingId ? 'PÄIVITÄ' : 'TALLENNA'}
              </button>
              {editingId && <button type="button" onClick={cancelEdit} className="cancel-btn">PERUUTA</button>}
            </div>
            {statusMessage && <p className="status-message" style={{ gridColumn: '1 / -1' }}>{statusMessage}</p>}
          </form>
        </div>
        {/* TRANSACTIONS TABLE */}
        <hr className="divider" />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px' }}>
        <h3 style={{ margin: 0 }}>TAPAHTUMAT</h3>
        <select
          value={ledgerMonthFilter}
          onChange={(e) => setLedgerMonthFilter(e.target.value)}
          style={{ width: 'auto', padding: '8px 12px' }}
        >
          <option value="all">Kaikki</option>
          {(() => {
            // Generate last 12 months as options
            const options = []
            const now = new Date()
            for (let i = 0; i < 12; i++) {
              const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
              const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
              const label = d.toLocaleDateString('fi-FI', { month: 'long', year: 'numeric' })
              options.push({ value, label })
            }
            return options.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))
          })()}
        </select>
      </div>
      <div className="table-container">
        <table className="transactions-table">
          <thead>
            <tr>
              <th>PÄIVÄMÄÄRÄ</th>
              <th>TYYPPI</th>
              <th>ASIAKAS</th>
              <th>SUMMA (BRUTTO)</th>
              <th>ALV %</th>
              <th>NETTO</th>
              <th>TILANNE</th>
              <th>TOIMINNAT</th>
            </tr>
          </thead>
          <tbody>
            {filteredTransactions.map((t) => (
              <tr key={t.id}>
                <td>{t.date_issued}</td>
                <td><span className={`badge ${t.type}`}>{t.type}</span></td>
                <td title={t.contact_name}>{t.contact_name}</td>
                <td style={{ fontWeight: '600' }}>{t.amount_gross}</td>
                <td>{t.tax_rate}%</td>
                <td>{t.amount_net}</td>
                <td>
                  <span
                    className={`badge ${t.status}`}
                    onClick={() => handleStatusToggle(t)}
                    style={{ cursor: t.type === 'income' ? 'pointer' : 'default' }}
                  >
                    {t.status} {t.date_paid && `(${t.date_paid})`}
                  </span>
                </td>
                <td>
                  <div className="action-cell">
                    <button onClick={() => handleEditClick(t)} className="edit-btn">MUOKKAA</button>
                    <button onClick={() => handleDelete(t.id)} className="delete-btn">POISTA</button>
                    {(t.receipt_image_url || t.invoice_pdf_url) && (
                      <button
                        onClick={async () => {
                          const url = t.receipt_image_url || t.invoice_pdf_url;
                          if (!url) return;

                          // Jos URL on julkinen (vanha), yritä muodostaa allekirjoitettu URL
                          if (url.includes('/object/public/')) {
                            try {
                              const match = url.match(/\/public\/(?:receipts|invoices)\/([^?]+)/);
                              if (match) {
                                const filePath = decodeURIComponent(match[1]);
                                const bucket = url.includes('/receipts/') ? 'receipts' : 'invoices';

                                // Varmista, että istunto on tuore
                                const { data: { session }, error: sessionError } = await supabase.auth.refreshSession();
                                if (sessionError) throw sessionError;

                                const { data: signedData, error: signedError } = await supabase.storage
                                  .from(bucket)
                                  .createSignedUrl(filePath, 1209600);

                                if (!signedError) {
                                  window.open(signedData.signedUrl, '_blank');
                                  // Päivitä tietueeseen uusi allekirjoitettu URL
                                  await supabase.from('transactions').update({
                                    invoice_pdf_url: signedData.signedUrl
                                  }).eq('id', t.id);
                                  setTransactions(prev => prev.map(item =>
                                    item.id === t.id ? { ...item, invoice_pdf_url: signedData.signedUrl } : item
                                  ));
                                  return;
                                }
                              }
                            } catch (e) {
                              console.warn('Signed URL creation failed, falling back to original URL:', e);
                              // Jos epäonnistui, avaa alkuperäinen (vanha) URL, vaikka se olisi rikki
                              window.open(url, '_blank');
                              return;
                            }
                          }
                          // Muuten avaa sellaisenaan
                          window.open(url, '_blank');
                        }}
                        className="view-btn"
                      >
                        NÄYTÄ
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}

      {/* REPORTS TAB */}
      {activeTab === 'reports' && (
        <div>
          <div className="report-controls" style={{ flexWrap: 'wrap' }}>
            <div className="input-group">
              <label>Vuosi</label>
              <select value={reportYear} onChange={(e) => setReportYear(e.target.value)}>
                {availableYears.map(year => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
            </div>
            <div className="input-group">
              <label>Aikaväli</label>
              <select value={reportPeriodType} onChange={(e) => setReportPeriodType(e.target.value)}>
                <option value="year">Koko vuosi</option>
                <option value="quarter">Neljännesvuosi</option>
                <option value="month">Kuukausi</option>
              </select>
            </div>
            {reportPeriodType === 'quarter' && (
              <div className="input-group">
                <label>Kvarttaali</label>
                <select value={selectedQuarter} onChange={(e) => setSelectedQuarter(e.target.value)}>
                  <option value="Q1">Q1</option>
                  <option value="Q2">Q2</option>
                  <option value="Q3">Q3</option>
                  <option value="Q4">Q4</option>
                </select>
              </div>
            )}
            {reportPeriodType === 'month' && (
              <div className="input-group">
                <label>Kuukausi</label>
                <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)}>
                  <option value="01">Tammikuu</option><option value="02">Helmikuu</option>
                  <option value="03">Maaliskuu</option><option value="04">Huhtikuu</option>
                  <option value="05">Toukokuu</option><option value="06">Kesäkuu</option>
                  <option value="07">Heinäkuu</option><option value="08">Elokuu</option>
                  <option value="09">Syyskuu</option><option value="10">Lokakuu</option>
                  <option value="11">Marraskuu</option><option value="12">Joulukuu</option>
                </select>
              </div>
            )}
          </div>

          <div className="report-grid">
            {/* 1. Kotimaan myyntien verot */}
            <div className="report-card">
              <h3>Kotimaan myynnit</h3>
              <table className="report-table">
                <tbody>
                  {Object.entries(reportData.alvSalesTax)
                    .filter(([, amount]) => amount > 0)
                    .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
                    .map(([rate, amount]) => (
                      <tr key={rate}>
                        <th>{rate} % vero</th>
                        <td className="money">{amount.toFixed(2)} €</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            {/* 2. Vähennettävä vero */}
            <div className="report-card">
              <h3>Vähennettävä vero</h3>
              <table className="report-table">
                <tbody>
                  <tr>
                    <th>Verokauden vähennettävä vero</th>
                    <td className="money">{reportData.totalVatPaid.toFixed(2)} €</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* 3. Maksettava vero */}
            <div className="report-card">
              <h3>Maksettava vero</h3>
              <table className="report-table">
                <tbody>
                  <tr>
                    <th>Maksettava vero</th>
                    <td className="money">{reportData.vatToPay.toFixed(2)} €</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* 4. 0-verokannan liikevaihto */}
            <div className="report-card">
              <h3>0-verokannan alainen liikevaihto</h3>
              <table className="report-table">
                <tbody>
                  <tr>
                    <th>Liikevaihto yhteensä</th>
                    <td className="money">{reportData.zeroTaxSalesNet.toFixed(2)} €</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* 5. EU-myynnit ja -ostot */}
            <div className="report-card">
              <h3>Myynnit ja ostot EU-maihin</h3>
              <table className="report-table">
                <tbody>
                  <tr><th>Tavaramyynnit EU-maihin</th><td className="money">{reportData.euSalesGoods.toFixed(2)} €</td></tr>
                  <tr><th>Palvelumyynnit EU-maihin</th><td className="money">{reportData.euSalesServices.toFixed(2)} €</td></tr>
                  <tr><th>Tavaraostot EU-maista</th><td className="money">{reportData.euPurchasesGoods.toFixed(2)} €</td></tr>
                  <tr><th>Palveluostot EU-maista</th><td className="money">{reportData.euPurchasesServices.toFixed(2)} €</td></tr>
                </tbody>
              </table>
            </div>

            {/* 6. Maahantuonnit EU:n ulkopuolelta */}
            <div className="report-card">
              <h3>Tavaroiden maahantuonnit</h3>
              <table className="report-table">
                <tbody>
                  <tr><th>Tavaraostot EU:n ulkop.</th><td className="money">{reportData.importGoods.toFixed(2)} €</td></tr>
                </tbody>
              </table>
            </div>

            {/* 7. Käännetty verovelvollisuus */}
            <div className="report-card">
              <h3>Käännetty verovelvollisuus</h3>
              <table className="report-table">
                <tbody>
                  <tr><th>Myynnit (rak/palv/metalli)</th><td className="money">{reportData.reverseChargeSales.toFixed(2)} €</td></tr>
                  <tr><th>Ostot (rak/palv/metalli)</th><td className="money">{reportData.reverseChargePurchases.toFixed(2)} €</td></tr>
                </tbody>
              </table>
            </div>

            {/* 8. Lomake 5 tuloslaskelma */}
            <div className="report-card">
              <h3>LOMAKE 5 (TULO)</h3>
              <div className="summary-box">
                <h4>Tulo</h4>
                <div className={`amount ${reportData.profit > 0 ? 'positive' : 'negative'}`}>
                  {reportData.profit.toFixed(2)} €
                </div>
              </div>
              <table className="report-table">
                <tbody>
                  <tr><th>TULO (NETTO)</th><td className="money">{reportData.totalIncomeNet.toFixed(2)} €</td></tr>
                  {Object.entries(reportData.expensesByCategory).map(([code, amount]) => (
                    <tr key={code}><th>Kulu {code}</th><td className="money">{amount.toFixed(2)} €</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* INVOICE TAB */}
      {activeTab === 'invoice' && (
        <div className="form-card">
          <h2>LUO UUSI LASKU</h2>
          <form onSubmit={handleInvoiceSubmit} className="form-grid">
            <div className="input-group">
              <label>LASKUN NUMERO</label>
              <input type="number" name="invoice_number" value={invoiceData.invoice_number} onChange={handleInvoiceChange} />
            </div>

            {/* Income Category Selector */}
            <div className="input-group">
              <label>TULON TYYPPI</label>
              <select
                name="income_category"
                value={invoiceData.income_category}
                onChange={(e) => {
                  const category = e.target.value; // tämä on merkkijono
                  const categoryNum = parseInt(category, 10); // muunna numeroksi
                  const taxRate = INCOME_TAX_RATES[categoryNum] || 25.5;
                  setInvoiceData({
                    ...invoiceData,
                    income_category: category,
                    tax_rate: String(taxRate)
                  });
                }}
                required
              >
                <option value="">-- Valitse --</option>
                {categories
                  .filter(c => c.type === 'income')
                  .map(c => (
                    <option key={c.code} value={c.code}>
                      {c.name_fi}
                    </option>
                  ))
                }
              </select>
            </div>

            {/* Customer Selection */}
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
                      setInvoiceData({
                        ...invoiceData,
                        selectedCustomerId: '',
                        buyer_name: '',
                        buyer_address: '',
                        reference_number: ''
                      })
                    }
                  }}
                  style={{ flex: 1, height: '42px' }}
                >
                  <option value="">-- Valitse asiakas --</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="submit-btn"
                  style={{
                    padding: '0 16px',
                    height: '42px',
                    whiteSpace: 'nowrap',
                    marginTop: '0',
                    flexShrink: 0
                  }}
                  onClick={() => setShowCustomerModal(true)}
                >
                  + Lisää uusi asiakas
                </button>
              </div>
            </div>

            {/* Description & Line Items */}
            <div className="input-group" style={{ gridColumn: '1 / -1' }}>
              <label>KUVAUS</label>
              <input type="text" name="description" value={invoiceData.description} onChange={handleInvoiceChange} />
            </div>
            <div className="input-group">
              <label>MÄÄRÄ</label>
              <input type="number" name="quantity" value={invoiceData.quantity} onChange={handleInvoiceChange} />
            </div>
            <div className="input-group">
              <label>YKSIKKÖ HINTA ALV 0%(€)</label>
              <input type="number" name="unit_price" value={invoiceData.unit_price} onChange={handleInvoiceChange} step="0.01" />
            </div>

            {/* Hidden fields for reference and project details (optional) */}
            <div className="input-group" style={{ gridColumn: '1 / -1' }}>
              <label>HANKKEEN LISÄTIEDOT</label>
              <input type="text" name="project_details" value={invoiceData.project_details} onChange={handleInvoiceChange} />
            </div>

            <button
            type="submit"
            className="submit-btn"
            disabled={isInvoiceLoading || !isInvoiceFormValid}
            style={{
              backgroundColor: isInvoiceLoading
                ? 'var(--primary-blue)'
                : isInvoiceFormValid
                  ? '#10b981'
                  : '#e5e7eb',           // light grey when disabled
              color: isInvoiceFormValid ? 'white' : '#9ca3af',
              border: isInvoiceFormValid ? 'none' : '1px solid #fca5a5', // subtle red hint
              cursor: isInvoiceFormValid ? 'pointer' : 'not-allowed',
            }}
          >
            {isInvoiceLoading
              ? 'Tallennetaan...'
              : isInvoiceFormValid
                ? 'TALLENNA'
                : 'TÄYTÄ KAIKKI KOHDAT'}
          </button>
          </form>
          {lastInvoiceUrl && (
            <div style={{ marginTop: '24px', padding: '16px', backgroundColor: 'var(--bg-main)', borderRadius: '8px' }}>
              <p style={{ marginBottom: '12px', fontWeight: 600 }}>
                ✅ Lasku {lastInvoiceNumber} – {settings.company_name || 'Yritys'} luotu!
              </p>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  onClick={() => {
                    window.open(lastInvoiceUrl, '_blank')
                    setInvoiceViewed(true)
                  }}
                  className="edit-btn"
                  style={{ flex: 1 }}
                >
                  📄 Näytä lasku
                </button>
                <button
                  onClick={() => {
                    const company = settings.company_name || 'Yritys'
                    const subject = `Lasku ${lastInvoiceNumber} – ${company}`
                    const body = `Hei,\n\nTässä linkki laskuun:\n${lastInvoiceUrl}\n\nKiitos!`
                    navigator.clipboard?.writeText(lastInvoiceUrl).catch(() => {})
                    window.location.href = `mailto:${invoiceData.buyer_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
                  }}
                  className="edit-btn"
                  style={{ flex: 1, opacity: invoiceViewed ? 1 : 0.5 }}
                  disabled={!invoiceViewed}
                  title={invoiceViewed ? 'Lähetä sähköpostilla' : 'Katso lasku ensin'}
                >
                  📧 Lähetä sähköpostilla
                </button>
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '8px' }}>
                Linkki on voimassa 14 päivää.
              </p>
            </div>
          )}
        </div>
      )}

      {/* SETTINGS TAB */}
      {activeTab === 'settings' && (
        <div className="form-card">
          <h2>ASETUKSET</h2>
          <form className="form-grid" onSubmit={(e) => e.preventDefault()}>
            <div className="input-group">
              <label>YRITYKSEN NIMI</label>
              <input
                type="text"
                name="company_name"
                value={settings.company_name || ''}
                onChange={handleSettingsChange}
              />
            </div>
            <div className="input-group">
              <label>OSOITE</label>
              <input
                type="text"
                name="company_address"
                value={settings.company_address || ''}
                onChange={handleSettingsChange}
              />
            </div>
            <div className="input-group">
              <label>PUHELIN</label>
              <input
                type="text"
                name="company_phone"
                value={settings.company_phone || ''}
                onChange={handleSettingsChange}
              />
            </div>
            <div className="input-group">
              <label>SÄHKÖPOSTI</label>
              <input
                type="email"
                name="company_email"
                value={settings.company_email || ''}
                onChange={handleSettingsChange}
              />
            </div>
            <div className="input-group">
              <label>IBAN</label>
              <input
                type="text"
                name="company_iban"
                value={settings.company_iban || ''}
                onChange={handleSettingsChange}
              />
            </div>
            <div className="input-group">
              <label>SWIFT</label>
              <input
                type="text"
                name="company_swift"
                value={settings.company_swift || ''}
                onChange={handleSettingsChange}
              />
            </div>
            <div className="input-group">
              <label>VAT</label>
              <input
                type="text"
                name="company_vat"
                value={settings.company_vat || ''}
                onChange={handleSettingsChange}
              />
            </div>
            <div className="input-group">
              <label>Y-tunnus</label>
              <input
                type="text"
                name="business_id"
                value={settings.business_id || ''}
                onChange={handleSettingsChange}
              />
            </div>
            <div className="input-group">
              <label>ALV OLETUS(%)</label>
              <select
                name="default_tax_rate"
                value={settings.default_tax_rate || '25.5'}
                onChange={handleSettingsChange}
              >
                <option value="25.5">25.5%</option>
                <option value="24">24%</option>
                <option value="14">14%</option>
                <option value="13.5">13.5%</option>
                <option value="10">10%</option>
                <option value="0">0%</option>
              </select>
            </div>
            <div className="input-group">
              <label>VIIVÄSTYSKORKO(%)</label>
              <input
                type="text"
                name="delay_tax_rate"
                value={settings.delay_tax_rate || ''}
                onChange={handleSettingsChange}
              />
            </div>
            <div className="input-group">
              <label>LASKUN ALKU</label>
              <input
                type="text"
                name="invoice_prefix"
                value={settings.invoice_prefix || ''}
                onChange={handleSettingsChange}
              />
            </div>
            <button
              type="button"
              className="submit-btn"
              onClick={() => {
                handleSettingsSave()
              }}
              disabled={isSettingsSaving}
            >
              {isSettingsSaving ? 'TALLENNETAAN...' : 'TALLENNA'}
            </button>
            <button type="button" onClick={handleExportData} className="edit-btn" style={{ flex: 1 }}>
              📥 LATAA VARMUUSKOPIO
            </button>
          </form>
        </div>
      )}
      {activeTab === 'customers' && (
      <div className="form-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h2>ASIAKKAAT</h2>
          <button
            className="submit-btn"
            style={{ padding: '10px 20px', width: 'auto' }}
            onClick={() => {
              setEditingCustomer(null)
              setNewCustomer({ name: '', address: '', y_tunnus: '', email: '', phone: '', reference_number: '' })
              setShowCustomerModal(true)
            }}
          >
            + Lisää uusi asiakas
          </button>
        </div>

        <div className="table-container">
          <table className="transactions-table">
            <thead>
              <tr>
                <th>NIMI</th>
                <th>OSOITE</th>
                <th>Y-TUNNUS</th>
                <th>SÄHKÖPOSTI</th>
                <th>PUHELIN</th>
                <th>VIITENUMERO</th>
                <th>TOIMINNOT</th>
              </tr>
            </thead>
            <tbody>
              {customers.length === 0 ? (
                <tr>
                  <td colSpan="7" style={{ textAlign: 'center', padding: '20px' }}>
                    Ei asiakkaita. Lisää uusi asiakas.
                  </td>
                </tr>
              ) : (
                customers.map(customer => (
                  <tr key={customer.id}>
                    <td>{customer.name}</td>
                    <td style={{ whiteSpace: 'pre-line' }}>{customer.address || '-'}</td>
                    <td>{customer.y_tunnus || '-'}</td>
                    <td>{customer.email || '-'}</td>
                    <td>{customer.phone || '-'}</td>
                    <td>{customer.reference_number || '-'}</td>
                    <td>
                      <div className="action-cell">
                        <button
                          className="edit-btn"
                          onClick={() => {
                            setEditingCustomer(customer)
                            setNewCustomer({
                              name: customer.name || '',
                              address: customer.address || '',
                              y_tunnus: customer.y_tunnus || '',
                              email: customer.email || '',
                              phone: customer.phone || '',
                              reference_number: customer.reference_number || ''
                            })
                            setShowCustomerModal(true)
                          }}
                        >
                          Muokkaa
                        </button>
                        <button
                          className="delete-btn"
                          onClick={async () => {
                            if (!window.confirm(`Poistetaanko asiakas "${customer.name}"?`)) return
                            const { error } = await supabase
                              .from('customers')
                              .delete()
                              .eq('id', customer.id)
                            if (!error) {
                              fetchCustomers()
                              // If the deleted customer was selected in invoice form, clear selection
                              if (invoiceData.selectedCustomerId === customer.id) {
                                setInvoiceData({
                                  ...invoiceData,
                                  selectedCustomerId: '',
                                  buyer_name: '',
                                  buyer_address: '',
                                  reference_number: ''
                                })
                              }
                            } else {
                              alert('Virhe poistossa: ' + error.message)
                            }
                          }}
                        >
                          Poista
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    )}
      {/* Customer Modal (Add / Edit) */}
      {showCustomerModal && (
        <div className="modal-overlay" onClick={() => {
          setShowCustomerModal(false)
          setEditingCustomer(null)
          setNewCustomer({ name: '', address: '', y_tunnus: '', email: '', phone: '', reference_number: '' })
        }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>{editingCustomer ? 'MUOKKAA' : 'UUSI ASIAKAS'}</h3>
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                if (!user) return

                let error = null
                let data = null

                if (editingCustomer) {
                  // Update existing customer
                  const result = await supabase
                    .from('customers')
                    .update({
                      name: newCustomer.name,
                      address: newCustomer.address,
                      y_tunnus: newCustomer.y_tunnus,
                      email: newCustomer.email,
                      phone: newCustomer.phone,
                      reference_number: newCustomer.reference_number
                    })
                    .eq('id', editingCustomer.id)
                    .select()
                  error = result.error
                  data = result.data
                } else {
                  // Insert new customer
                  const result = await supabase
                    .from('customers')
                    .insert([{ ...newCustomer, user_id: user.id }])
                    .select()
                  error = result.error
                  data = result.data
                }

                if (!error) {
                  await fetchCustomers()
                  
                  // If we were editing, and the edited customer is currently selected in invoice,
                  // update the invoice data with new values
                  if (editingCustomer && invoiceData.selectedCustomerId === editingCustomer.id && data?.[0]) {
                    setInvoiceData({
                      ...invoiceData,
                      buyer_name: data[0].name,
                      buyer_address: data[0].address || '',
                      reference_number: data[0].reference_number || ''
                    })
                  }
                  
                  // Reset and close modal
                  setNewCustomer({ name: '', address: '', y_tunnus: '', email: '', phone: '', reference_number: '' })
                  setEditingCustomer(null)
                  setShowCustomerModal(false)
                } else {
                  alert('Virhe: ' + error.message)
                }
              }}
            >
              <div className="form-grid">
                <div className="input-group">
                  <label>Nimi *</label>
                  <input
                    type="text"
                    value={newCustomer.name}
                    onChange={(e) => setNewCustomer({...newCustomer, name: e.target.value})}
                    required
                  />
                </div>
                <div className="input-group" style={{ gridColumn: '1 / -1' }}>
                  <label>Osoite</label>
                  <textarea
                    value={newCustomer.address}
                    onChange={(e) => setNewCustomer({...newCustomer, address: e.target.value})}
                    rows="2"
                  />
                </div>
                <div className="input-group">
                  <label>Y-tunnus</label>
                  <input
                    type="text"
                    value={newCustomer.y_tunnus}
                    onChange={(e) => setNewCustomer({...newCustomer, y_tunnus: e.target.value})}
                  />
                </div>
                <div className="input-group">
                  <label>Sähköposti</label>
                  <input
                    type="email"
                    value={newCustomer.email}
                    onChange={(e) => setNewCustomer({...newCustomer, email: e.target.value})}
                  />
                </div>
                <div className="input-group">
                  <label>Puhelin</label>
                  <input
                    type="text"
                    value={newCustomer.phone}
                    onChange={(e) => setNewCustomer({...newCustomer, phone: e.target.value})}
                  />
                </div>
                <div className="input-group">
                  <label>Viitenumero</label>
                  <input
                    type="text"
                    value={newCustomer.reference_number}
                    onChange={(e) => setNewCustomer({...newCustomer, reference_number: e.target.value})}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                <button type="submit" className="submit-btn" style={{ flex: 1 }}>
                  {editingCustomer ? 'TALLENNA MUUTOKSET' : 'TALLENNA'}
                </button>
                <button
                  type="button"
                  className="cancel-btn"
                  onClick={() => {
                    setShowCustomerModal(false)
                    setEditingCustomer(null)
                    setNewCustomer({ name: '', address: '', y_tunnus: '', email: '', phone: '', reference_number: '' })
                  }}
                >
                  Peruuta
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default App