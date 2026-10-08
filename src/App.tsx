import { Component, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import BottomNav from './componentes/BottomNav'
import SubjectList from './componentes/SubjectList'
import { supabase } from './lib/supabase'
import type { Session } from '@supabase/supabase-js'
import { jsPDF } from 'jspdf'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'

console.log('APP CSS CARGADO')

interface Material {
  id: number
  fileName: string
  path: string
  tipo: 'principal' | 'adicional'
}

interface Topic {
  id: number
  name: string
  materials: Material[]
}

interface Tarjeta {
  id: number
  tema_id: number
  pregunta: string
  respuesta: string
  caja: number
}

interface PreguntaExamen {
  id: number
  titulo: string
  enunciado: string
  solucion: string
  dificultad: string
  tema_id: number | null
}

interface ResultadoExamen {
  correcta: boolean
  comentario: string
}

interface EstadoExamen {
  preguntas: PreguntaExamen[]
  indice: number
  respuestas: string[]
  fase: 'respondiendo' | 'corrigiendo' | 'resultado'
    modo: 'normal' | 'simulacro'
  inicioMs: number
  finMs: number | null
  progreso: number
  resultados: ResultadoExamen[]
  recomendacion: string
}

// Días hasta la próxima revisión según la caja (1 a 5)
const INTERVALOS_CAJA = [0, 1, 2, 4, 7, 15]

// Objetivo diario
const OBJETIVO_DIARIO_EJERCICIOS = 10
const OBJETIVO_DIARIO_XP = 100

// Caché del texto de los PDFs (evita extraer el mismo PDF varias veces)
const cacheTextoPdf = new Map<string, string>()


// Dirección del servidor de IA: la misma máquina desde la que abres la web
// (localhost en el PC, la IP de tu PC en el móvil)
const API_IA: string =
  import.meta.env.VITE_API_IA ?? `http://${window.location.hostname}:3001`

  
// Cada petición al servidor de IA lleva tu sesión de Supabase
if (!(window as any).__fetchAuthIA) {
  const fetchPrevio = window.fetch.bind(window)

  window.fetch = async (
    entrada: RequestInfo | URL,
    opciones?: RequestInit,
  ) => {
    const url =
      typeof entrada === 'string'
        ? entrada
        : entrada instanceof URL
          ? entrada.href
          : entrada.url

    if (url.startsWith(API_IA)) {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token

      if (token) {
        const cabeceras = new Headers(opciones?.headers)

        cabeceras.set('Authorization', `Bearer ${token}`)

        return fetchPrevio(entrada, { ...opciones, headers: cabeceras })
      }
    }

    return fetchPrevio(entrada, opciones)
  }

  ;(window as any).__fetchAuthIA = true
}

// Los PDFs son privados: cualquier descarga desde la URL pública de Materiales
// se convierte automáticamente en un enlace temporal firmado
if (!(window as any).__fetchFirmado) {
  const fetchOriginal = window.fetch.bind(window)

  window.fetch = async (
    entrada: RequestInfo | URL,
    opciones?: RequestInit,
  ) => {
    const url =
      typeof entrada === 'string'
        ? entrada
        : entrada instanceof URL
          ? entrada.href
          : entrada.url

    const marca = '/storage/v1/object/public/Materiales/'
    const posicion = url.indexOf(marca)

    if (posicion !== -1) {
      const ruta = decodeURIComponent(
        url.slice(posicion + marca.length).split('?')[0],
      )

      const { data } = await supabase.storage
        .from('Materiales')
        .createSignedUrl(ruta, 300)

      if (data?.signedUrl) {
        return fetchOriginal(data.signedUrl, opciones)
      }
    }

    return fetchOriginal(entrada, opciones)
  }

  ;(window as any).__fetchFirmado = true
} 

// Descarga un PDF privado de Supabase Storage usando un enlace temporal
async function descargarPdf(ruta: string, nombre: string): Promise<File> {
  const { data, error } = await supabase.storage
    .from('Materiales')
    .createSignedUrl(ruta, 300)

  if (error || !data) {
    throw new Error('No se ha podido acceder al PDF.')
  }

  const respuesta = await fetch(data.signedUrl)

  if (!respuesta.ok) {
    throw new Error('No se ha podido descargar el PDF.')
  }

  const blob = await respuesta.blob()

  return new File([blob], nombre, { type: 'application/pdf' })
}

// Enlace temporal (1 hora) para abrir un PDF en otra pestaña
async function urlTemporalPdf(ruta: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from('Materiales')
    .createSignedUrl(ruta, 3600)

  if (error || !data) {
    throw new Error('No se ha podido abrir el PDF.')
  }

  return data.signedUrl
}

// Si algo inesperado rompe la pantalla, se muestra un aviso en vez de una pantalla en blanco
class LimiteErrores extends Component<
  { children: ReactNode },
  { fallo: boolean }
> {
  state = { fallo: false }

  static getDerivedStateFromError() {
    return { fallo: true }
  }

  componentDidCatch(error: unknown) {
    console.error('Error inesperado en la aplicación:', error)
  }

  render() {
    if (this.state.fallo) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'grid',
            placeItems: 'center',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <div>
            <div style={{ fontSize: '48px' }}>😵</div>

            <h2>Ha passat alguna cosa inesperada</h2>

            <p style={{ margin: '8px 0 20px', color: '#6b6b80' }}>
              Prova de tornar a carregar l'aplicació.
            </p>

            <button
              className="app-button app-button-primary"
              type="button"
              onClick={() => window.location.reload()}
            >
              Tornar a carregar
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

interface NivelLogro {
  id: string
  texto: string
  emoji: string
  conseguido: boolean
  condiciones: { etiqueta: string; valor: number; meta: number }[]
}

interface CadenaLogro {
  id: string
  icono: string
  titulo: string
  niveles: NivelLogro[]
}

interface MetricasLogros {
  correctas: number
  respuestas: number
  pctAcierto: number
  xp: number
  diasActivos: number
  mejorRachaDias: number
  mejorSerie: number
  temasDominados: number
  asignaturasActivas: number
  asignaturasExcelentes: number
  erroresSuperados: number
  tarjetasDominadas: number
  preguntasIA: number
}

// Posición de los emojis sobre la foto de perfil (hasta 3)
const POSICIONES_COMPLEMENTO: React.CSSProperties[] = [
  { top: '-10px', left: '-10px' },
  { top: '-10px', right: '-10px' },
  { bottom: '-10px', left: '-10px' },
]

function BarraLogro({ porcentaje }: { porcentaje: number }) {
  const valor = Math.max(0, Math.min(100, porcentaje))

  return (
    <div
      style={{
        height: '8px',
        borderRadius: '8px',
        background: '#ececf4',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${valor}%`,
          background: '#6d5dfc',
        }}
      />
    </div>
  )
}

// Cadenas de reptes: cada nivel es más específico y difícil que el anterior
function construirLogros(
  m: MetricasLogros,
  guardados: string[],
): CadenaLogro[] {
  const cadena = (
    id: string,
    icono: string,
    titulo: string,
    niveles: {
      texto: string
      emoji: string
      condiciones: [string, number, number][]
    }[],
  ): CadenaLogro => ({
    id,
    icono,
    titulo,
    niveles: niveles.map((nivel, indice) => {
      const condiciones = nivel.condiciones.map(
        ([etiqueta, valor, meta]) => ({ etiqueta, valor, meta }),
      )

      const nivelId = `${id}-${indice + 1}`

      return {
        id: nivelId,
        texto: nivel.texto,
        emoji: nivel.emoji,
        conseguido:
          guardados.includes(nivelId) ||
          condiciones.every((condicion) => condicion.valor >= condicion.meta),
        condiciones,
      }
    }),
  })

  const ENCERT = "% d'encert"
  const ASIG = 'Assignatures amb activitat'

  return [
    cadena('encert', '✅', 'Encert', [
      { texto: 'Respon correctament el teu primer exercici', emoji: '🌱', condiciones: [['Correctes', m.correctas, 1]] },
      { texto: 'Encerta 10 exercicis', emoji: '🍀', condiciones: [['Correctes', m.correctas, 10]] },
      { texto: 'Encerta 25 exercicis en 2 assignatures diferents', emoji: '⭐', condiciones: [['Correctes', m.correctas, 25], [ASIG, m.asignaturasActivas, 2]] },
      { texto: "Encerta 50 exercicis amb un 70% d'encert global", emoji: '🌟', condiciones: [['Correctes', m.correctas, 50], [ENCERT, m.pctAcierto, 70]] },
      { texto: "Encerta 100 exercicis, un 75% d'encert i 3 assignatures", emoji: '💎', condiciones: [['Correctes', m.correctas, 100], [ENCERT, m.pctAcierto, 75], [ASIG, m.asignaturasActivas, 3]] },
      { texto: "Encerta 250 exercicis amb un 80% d'encert", emoji: '👑', condiciones: [['Correctes', m.correctas, 250], [ENCERT, m.pctAcierto, 80]] },
      { texto: "Encerta 500 exercicis, un 85% d'encert i 3 assignatures", emoji: '🏆', condiciones: [['Correctes', m.correctas, 500], [ENCERT, m.pctAcierto, 85], [ASIG, m.asignaturasActivas, 3]] },
    ]),

    cadena('xp', '✦', 'Experiència', [
      { texto: 'Aconsegueix 100 XP', emoji: '🔰', condiciones: [['XP', m.xp, 100]] },
      { texto: 'Aconsegueix 300 XP', emoji: '🥉', condiciones: [['XP', m.xp, 300]] },
      { texto: "Aconsegueix 600 XP amb un 60% d'encert", emoji: '🥈', condiciones: [['XP', m.xp, 600], [ENCERT, m.pctAcierto, 60]] },
      { texto: "Aconsegueix 1.200 XP amb un 70% d'encert", emoji: '🥇', condiciones: [['XP', m.xp, 1200], [ENCERT, m.pctAcierto, 70]] },
      { texto: "Aconsegueix 2.500 XP amb un 75% d'encert", emoji: '💠', condiciones: [['XP', m.xp, 2500], [ENCERT, m.pctAcierto, 75]] },
      { texto: "Aconsegueix 5.000 XP amb un 80% d'encert", emoji: '🚀', condiciones: [['XP', m.xp, 5000], [ENCERT, m.pctAcierto, 80]] },
    ]),

    cadena('constancia', '📅', 'Constància', [
      { texto: 'Estudia en 3 dies diferents', emoji: '🕯️', condiciones: [['Dies estudiats', m.diasActivos, 3]] },
      { texto: 'Estudia en 7 dies diferents', emoji: '📚', condiciones: [['Dies estudiats', m.diasActivos, 7]] },
      { texto: 'Estudia en 14 dies i arriba a una ratxa de 5 dies seguits', emoji: '🧭', condiciones: [['Dies estudiats', m.diasActivos, 14], ['Millor ratxa', m.mejorRachaDias, 5]] },
      { texto: 'Estudia en 30 dies i arriba a una ratxa de 10 dies seguits', emoji: '🏔️', condiciones: [['Dies estudiats', m.diasActivos, 30], ['Millor ratxa', m.mejorRachaDias, 10]] },
      { texto: 'Estudia en 60 dies i arriba a una ratxa de 20 dies seguits', emoji: '🌌', condiciones: [['Dies estudiats', m.diasActivos, 60], ['Millor ratxa', m.mejorRachaDias, 20]] },
    ]),

    cadena('racha', '🔥', 'Ratxa', [
      { texto: 'Estudia 3 dies seguits', emoji: '🔥', condiciones: [['Dies seguits', m.mejorRachaDias, 3]] },
      { texto: 'Estudia 7 dies seguits', emoji: '☄️', condiciones: [['Dies seguits', m.mejorRachaDias, 7]] },
      { texto: 'Estudia 14 dies seguits', emoji: '🌋', condiciones: [['Dies seguits', m.mejorRachaDias, 14]] },
      { texto: 'Estudia 30 dies seguits', emoji: '⚡', condiciones: [['Dies seguits', m.mejorRachaDias, 30]] },
      { texto: 'Estudia 60 dies seguits', emoji: '🐉', condiciones: [['Dies seguits', m.mejorRachaDias, 60]] },
    ]),

    cadena('precision', '🎯', 'Precisió', [
      { texto: 'Encerta 5 exercicis seguits', emoji: '🎯', condiciones: [['Encerts seguits', m.mejorSerie, 5]] },
      { texto: 'Encerta 10 exercicis seguits', emoji: '🏹', condiciones: [['Encerts seguits', m.mejorSerie, 10]] },
      { texto: 'Encerta 20 exercicis seguits havent encertat 50 en total', emoji: '🧿', condiciones: [['Encerts seguits', m.mejorSerie, 20], ['Correctes', m.correctas, 50]] },
      { texto: 'Encerta 35 exercicis seguits havent encertat 150 en total', emoji: '🧠', condiciones: [['Encerts seguits', m.mejorSerie, 35], ['Correctes', m.correctas, 150]] },
    ]),

    cadena('domini', '🎓', 'Domini', [
      { texto: 'Arriba al nivell Difícil en un tema', emoji: '🎓', condiciones: [['Temes dominats', m.temasDominados, 1]] },
      { texto: 'Domina 2 temes', emoji: '📜', condiciones: [['Temes dominats', m.temasDominados, 2]] },
      { texto: 'Domina 4 temes i tingues una assignatura excel·lent', emoji: '🧙', condiciones: [['Temes dominats', m.temasDominados, 4], ['Assignatures excel·lents', m.asignaturasExcelentes, 1]] },
      { texto: 'Domina 7 temes i tingues 2 assignatures excel·lents', emoji: '🦉', condiciones: [['Temes dominats', m.temasDominados, 7], ['Assignatures excel·lents', m.asignaturasExcelentes, 2]] },
    ]),

    cadena('memoria', '🎴', 'Memòria', [
      { texto: 'Domina 5 flashcards (caixa 4 o superior)', emoji: '🎴', condiciones: [['Flashcards dominades', m.tarjetasDominadas, 5]] },
      { texto: 'Domina 15 flashcards', emoji: '🃏', condiciones: [['Flashcards dominades', m.tarjetasDominadas, 15]] },
      { texto: 'Domina 40 flashcards', emoji: '🧩', condiciones: [['Flashcards dominades', m.tarjetasDominadas, 40]] },
      { texto: 'Domina 100 flashcards', emoji: '🗝️', condiciones: [['Flashcards dominades', m.tarjetasDominadas, 100]] },
    ]),

    cadena('errors', '🩹', 'Aprendre dels errors', [
      { texto: 'Repassa i supera 1 error', emoji: '🩹', condiciones: [['Errors repassats', m.erroresSuperados, 1]] },
      { texto: 'Repassa 5 errors', emoji: '🔧', condiciones: [['Errors repassats', m.erroresSuperados, 5]] },
      { texto: "Repassa 15 errors amb un 70% d'encert", emoji: '🛠️', condiciones: [['Errors repassats', m.erroresSuperados, 15], [ENCERT, m.pctAcierto, 70]] },
      { texto: "Repassa 40 errors amb un 75% d'encert", emoji: '🧬', condiciones: [['Errors repassats', m.erroresSuperados, 40], [ENCERT, m.pctAcierto, 75]] },
    ]),

    cadena('curiositat', '🤖', 'Curiositat', [
      { texto: 'Fes la teva primera pregunta a la IA', emoji: '🤖', condiciones: [['Preguntes a la IA', m.preguntasIA, 1]] },
      { texto: 'Fes 10 preguntes a la IA', emoji: '💬', condiciones: [['Preguntes a la IA', m.preguntasIA, 10]] },
      { texto: 'Fes 40 preguntes a la IA i domina 5 flashcards', emoji: '🔮', condiciones: [['Preguntes a la IA', m.preguntasIA, 40], ['Flashcards dominades', m.tarjetasDominadas, 5]] },
      { texto: 'Fes 120 preguntes a la IA i repassa 5 errors', emoji: '🛰️', condiciones: [['Preguntes a la IA', m.preguntasIA, 120], ['Errors repassats', m.erroresSuperados, 5]] },
    ]),
  ]
}

// Formato mm:ss (o h:mm:ss)
function formatoTiempo(segundos: number) {
  const horas = Math.floor(segundos / 3600)
  const minutos = Math.floor((segundos % 3600) / 60)
  const resto = segundos % 60
  const dos = (n: number) => String(n).padStart(2, '0')

  return horas > 0
    ? `${horas}:${dos(minutos)}:${dos(resto)}`
    : `${dos(minutos)}:${dos(resto)}`
}

const PRESETS_POMODORO = {
  '25-5': {
    nombre: '25 min de focus / 5 de descans',
    foco: 25,
    descanso: 5,
    descansoLargo: 15,
    xp: 5,
  },
  '50-10': {
    nombre: '50 min de focus / 10 de descans',
    foco: 50,
    descanso: 10,
    descansoLargo: 30,
    xp: 10,
  },
}

const MAX_POMODOROS_XP_DIA = 8

// Sonido de aviso (el audio se activa al pulsar "Començar")
let contextoAudio: AudioContext | null = null

function prepararAudio() {
  try {
    if (!contextoAudio) {
      const Constructor =
        window.AudioContext || (window as any).webkitAudioContext

      contextoAudio = new Constructor()
    }

    if (contextoAudio && contextoAudio.state === 'suspended') {
      contextoAudio.resume()
    }
  } catch (error) {
    console.error('Error preparando el audio:', error)
  }
}

function sonarAviso() {
  try {
    const contexto = contextoAudio

    if (!contexto) {
      return
    }

    const oscilador = contexto.createOscillator()
    const ganancia = contexto.createGain()

    oscilador.type = 'sine'
    oscilador.frequency.value = 880
    ganancia.gain.value = 0.2

    oscilador.connect(ganancia)
    ganancia.connect(contexto.destination)

    oscilador.start()
    oscilador.stop(contexto.currentTime + 0.6)
  } catch (error) {
    console.error('Error reproduciendo el aviso:', error)
  }
}

// Descarga un archivo de texto desde el navegador
function descargarArchivo(nombre: string, contenido: string, tipo: string) {
  const blob = new Blob([contenido], { type: tipo })
  const url = URL.createObjectURL(blob)
  const enlace = document.createElement('a')

  enlace.href = url
  enlace.download = nombre

  document.body.appendChild(enlace)
  enlace.click()
  enlace.remove()

  URL.revokeObjectURL(url)
}

// Lee un CSV o un TXT de Anki (detecta solo si se separa por coma, punto y coma o tabulador)
function parsearCsv(texto: string): string[][] {
  const lineas = texto
    .split(/\r?\n/)
    .filter((linea) => linea.trim() !== '' && !linea.startsWith('#'))

  const primera = lineas[0] ?? ''

  const separador = primera.includes('\t')
    ? '\t'
    : primera.split(';').length > primera.split(',').length
      ? ';'
      : ','

  return lineas.map((linea) => {
    const celdas: string[] = []
    let actual = ''
    let entreComillas = false

    for (let i = 0; i < linea.length; i++) {
      const caracter = linea[i]

      if (caracter === '"') {
        if (entreComillas && linea[i + 1] === '"') {
          actual += '"'
          i++
        } else {
          entreComillas = !entreComillas
        }
      } else if (caracter === separador && !entreComillas) {
        celdas.push(actual.trim())
        actual = ''
      } else {
        actual += caracter
      }
    }

    celdas.push(actual.trim())

    return celdas
  })
}

// ----- Plan de estudio -----
interface TareaPlan {
  id: string
  fecha: string
  texto: string
  tipo:
    | 'teoria'
    | 'apuntes'
    | 'flashcards'
    | 'ejercicios'
    | 'refuerzo'
    | 'errores'
    | 'examen'
    | 'simulacro'
    | 'pomodoro'
    | 'ia'
    | 'descanso'
  hecho: boolean
}

function diasEntre(desde: string, hasta: string) {
  const a = new Date(`${desde}T00:00:00`)
  const b = new Date(`${hasta}T00:00:00`)

  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

function fechaMas(fecha: string, dias: number) {
  const resultado = new Date(`${fecha}T00:00:00`)

  resultado.setDate(resultado.getDate() + dias)

  return resultado.toLocaleDateString('sv-SE')
}

function agruparPorDia(tareas: TareaPlan[]) {
  const dias: { fecha: string; tareas: TareaPlan[] }[] = []

  for (const tarea of tareas) {
    const ultimo = dias[dias.length - 1]

    if (ultimo && ultimo.fecha === tarea.fecha) {
      ultimo.tareas.push(tarea)
    } else {
      dias.push({ fecha: tarea.fecha, tareas: [tarea] })
    }
  }

  return dias
}

// Reparte las tareas desde hoy hasta el día del examen, según tus datos
function construirPlan(datos: {
  hoy: string
  fechaExamen: string
  acierto: number | null
  erroresPendientes: number
  problemaRecurrente: boolean
  tieneApuntes: boolean
  tarjetas: number
}): TareaPlan[] {
  const total = Math.min(28, diasEntre(datos.hoy, datos.fechaExamen) + 1)

  if (total < 1) {
    return []
  }

  const tareas: TareaPlan[] = []
  const flojo = datos.acierto !== null && datos.acierto < 60

  for (let i = 0; i < total; i++) {
    const fecha = fechaMas(datos.fechaExamen, -(total - 1 - i))
    const posicion = total === 1 ? 1 : i / (total - 1)

    const agregar = (tipo: TareaPlan['tipo'], texto: string) => {
      tareas.push({
        id: `${fecha}-${tareas.length}`,
        fecha,
        texto,
        tipo,
        hecho: false,
      })
    }

    // El examen es hoy: solo un repaso rápido
    if (total === 1) {
      agregar('apuntes', 'Repàs ràpid dels apunts')
      agregar('flashcards', 'Repassa les targetes pendents')
      agregar('errores', 'Repassa els teus errors')
      break
    }

    // Día del examen
    if (i === total - 1) {
      agregar('apuntes', "Repàs lleuger dels apunts abans de l'examen")
      agregar('flashcards', 'Repassa les targetes pendents')
      agregar('descanso', "Dorm bé i arriba descansat/da a l'examen")
      continue
    }

    // Primer día
    if (i === 0) {
      agregar('teoria', 'Llegeix el PDF principal del tema amb calma')
      agregar(
        'apuntes',
        datos.tieneApuntes
          ? 'Repassa els apunts del tema'
          : 'Genera els apunts del tema amb la IA',
      )

      if (datos.tarjetas === 0) {
        agregar('flashcards', 'Genera targetes (flashcards) del tema')
      }

      continue
    }

    // Dos días antes: simulacro
    if (i === total - 2 && total >= 4) {
      agregar('simulacro', "Fes un simulacre d'1 hora")
      agregar('errores', 'Repassa els errors del simulacre')
      continue
    }

    if (posicion < 0.35) {
      agregar('teoria', 'Estudia un bloc del tema (2 pomodoros)')
      agregar('ia', 'Pregunta a la IA els conceptes que no entenguis')

      if (datos.tarjetas > 0) {
        agregar('flashcards', 'Repassa les targetes del dia')
      }
    } else if (posicion < 0.7) {
      agregar('ejercicios', flojo ? 'Fes 8 exercicis del tema' : 'Fes 5 exercicis del tema')

      if (datos.problemaRecurrente && i % 2 === 0) {
        agregar('refuerzo', 'Practica els exercicis de reforç del tema')
      }

      if (datos.erroresPendientes > 0 && i % 2 === 1) {
        agregar('errores', `Repassa els errors pendents (${datos.erroresPendientes})`)
      }

      if (datos.tarjetas > 0) {
        agregar('flashcards', 'Repassa les targetes del dia')
      }

      agregar('pomodoro', 'Fes 1 bloc Pomodoro de repàs')
    } else {
      agregar('examen', "Fes un examen de 10 preguntes del tema")
      agregar('errores', 'Repassa els errors del dia')

      if (datos.tarjetas > 0) {
        agregar('flashcards', 'Repassa les targetes difícils')
      }
    }
  }

  return tareas
}

// ----- Apuntes y PDF -----
// Trozos del texto repartidos por todo el documento (máximo 6)
function dividirEnBloques(texto: string, tamano = 3000, maximo = 6): string[] {
  const limpio = texto.replace(/\s+/g, ' ').trim()

  if (limpio.length === 0) {
    return []
  }

  if (limpio.length <= tamano) {
    return [limpio]
  }

  const cantidad = Math.min(maximo, Math.ceil(limpio.length / tamano))
  const paso = (limpio.length - tamano) / Math.max(1, cantidad - 1)
  const bloques: string[] = []

  for (let i = 0; i < cantidad; i++) {
    const inicio = Math.round(i * paso)

    bloques.push(limpio.slice(inicio, inicio + tamano))
  }

  return bloques
}

// El PDF solo admite letras latinas: se quitan emojis y símbolos raros
function limpiarParaPdf(texto: string) {
  return texto
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\u0000-\u00FF]/g, '')
}

function crearPdfApuntes(titulo: string, subtitulo: string, contenido: string) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const margen = 18
  const anchoUtil = 210 - margen * 2
  let y = margen

  const saltarSiHaceFalta = (alto: number) => {
    if (y + alto > 297 - margen) {
      doc.addPage()
      y = margen
    }
  }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(20)
  doc.setTextColor(23, 23, 31)

  const lineasTitulo = doc.splitTextToSize(limpiarParaPdf(titulo), anchoUtil)

  doc.text(lineasTitulo, margen, y + 6)
  y += lineasTitulo.length * 9 + 2

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(120, 120, 140)
  doc.text(limpiarParaPdf(subtitulo), margen, y + 2)
  y += 8

  doc.setDrawColor(109, 93, 252)
  doc.setLineWidth(0.8)
  doc.line(margen, y, margen + 40, y)
  y += 8

  for (const linea of contenido.split('\n')) {
    if (linea.trim() === '') {
      y += 2
      continue
    }

    if (linea.startsWith('## ')) {
      saltarSiHaceFalta(16)
      y += 4

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(13)
      doc.setTextColor(109, 93, 252)

      const lineas = doc.splitTextToSize(limpiarParaPdf(linea.slice(3)), anchoUtil)

      doc.text(lineas, margen, y)
      y += lineas.length * 6 + 2
    } else {
      const esPunto = linea.startsWith('- ')
      const sangria = esPunto ? 6 : 0

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(11)
      doc.setTextColor(40, 40, 58)

      const lineas = doc.splitTextToSize(
        limpiarParaPdf(esPunto ? linea.slice(2) : linea),
        anchoUtil - sangria,
      )

      saltarSiHaceFalta(lineas.length * 5.2 + 1.5)

      if (esPunto) {
        doc.text('•', margen + 1, y)
      }

      doc.text(lineas, margen + sangria, y)
      y += lineas.length * 5.2 + 1.5
    }
  }

  const paginas = doc.getNumberOfPages()

  for (let i = 1; i <= paginas; i++) {
    doc.setPage(i)
    doc.setFontSize(9)
    doc.setTextColor(150, 150, 170)
    doc.text(`${i} / ${paginas}`, 105, 290, { align: 'center' })
  }

  return doc
}

// ----- Visor de PDF -----
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

interface SubrayadoVisor {
  id: number
  pagina: number
  rects: { x: number; y: number; w: number; h: number }[]
  texto: string
  color: string
}

interface MarcadorVisor {
  id: number
  pagina: number
  nota: string
}

const COLORES_SUBRAYADO: Record<string, string> = {
  amarillo: '#ffe066',
  verde: '#8ce99a',
  rosa: '#faa2c1',
  azul: '#74c0fc',
}

// ----- Voz e inglés -----
interface ResultadoRedaccion {
  texto_corregido: string
  errores: { original: string; correccion: string; explicacion: string }[]
  puntuacion: number
  consejo: string
}

const IDIOMAS_DICTADO = [
  { codigo: 'es-ES', nombre: 'Español' },
  { codigo: 'ca-ES', nombre: 'Català' },
  { codigo: 'en-US', nombre: 'English (US)' },
  { codigo: 'en-GB', nombre: 'English (UK)' },
]

const IDIOMAS_INGLES = IDIOMAS_DICTADO.filter((idioma) =>
  idioma.codigo.startsWith('en'),
)

const FRASES_INGLES = [
  'Thank you for contacting our customer service team.',
  'I would like to schedule a meeting for next Tuesday.',
  'Our target audience is young professionals between twenty five and thirty five.',
  'We are launching a new advertising campaign next month.',
  'Could you send me the quotation by the end of the week?',
  'The market research shows that customers prefer sustainable products.',
  'I am responsible for managing the social media accounts of the company.',
  'Let me introduce our marketing strategy for the next quarter.',
  'We need to increase brand awareness among new customers.',
  'I look forward to hearing from you soon.',
  'Please find attached the report with the sales results.',
  'Our unique selling proposition is quality at an affordable price.',
]

// Lee un texto en voz alta (síntesis de voz del navegador)
function leerEnVoz(texto: string, idioma: string) {
  try {
    window.speechSynthesis.cancel()

    const lectura = new SpeechSynthesisUtterance(texto)

    lectura.lang = idioma
    lectura.rate = 0.9

    window.speechSynthesis.speak(lectura)
  } catch (error) {
    console.error('Error leyendo en voz alta:', error)
  }
}

function normalizarPalabras(texto: string) {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

// Compara la frase modelo con lo que has dicho (palabra por palabra)
function compararPronunciacion(objetivo: string, dicho: string) {
  const a = normalizarPalabras(objetivo)
  const b = normalizarPalabras(dicho)

  const tabla: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      tabla[i][j] =
        a[i - 1] === b[j - 1]
          ? tabla[i - 1][j - 1] + 1
          : Math.max(tabla[i - 1][j], tabla[i][j - 1])
    }
  }

  const acertadas: boolean[] = new Array(a.length).fill(false)
  let i = a.length
  let j = b.length

  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      acertadas[i - 1] = true
      i--
      j--
    } else if (tabla[i - 1][j] >= tabla[i][j - 1]) {
      i--
    } else {
      j--
    }
  }

  return {
    porcentaje:
      a.length === 0
        ? 0
        : Math.round((acertadas.filter(Boolean).length / a.length) * 100),
    palabras: a.map((palabra, indice) => ({
      palabra,
      ok: acertadas[indice],
    })),
  }
}

// Botón 🎤 con selector de idioma (dictado por voz del navegador)
function BotonDictado({
  idioma,
  onIdioma,
  idiomas,
  onTexto,
}: {
  idioma: string
  onIdioma: (codigo: string) => void
  idiomas: { codigo: string; nombre: string }[]
  onTexto: (texto: string) => void
}) {
  const [escuchando, setEscuchando] = useState(false)
  const reconocimientoRef = useRef<any>(null)

  function alternar() {
    if (escuchando) {
      reconocimientoRef.current?.stop()
      return
    }

    const Constructor =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition

    if (!Constructor) {
      window.alert(
        'El teu navegador no admet el dictat per veu. Prova Chrome, Edge o Safari.',
      )
      return
    }

    const reconocimiento = new Constructor()

    reconocimiento.lang = idioma
    reconocimiento.interimResults = false
    reconocimiento.continuous = false

    reconocimiento.onresult = (evento: any) => {
      const texto = Array.from(evento.results)
        .map((resultado: any) => resultado[0].transcript)
        .join(' ')
        .trim()

      if (texto) {
        onTexto(texto)
      }
    }

    reconocimiento.onerror = (evento: any) => {
      console.error('Error de dictado:', evento.error)

      if (evento.error === 'not-allowed') {
        window.alert(
          "No tinc permís per al micròfon. Permet-lo al navegador (i recorda que al mòbil cal HTTPS).",
        )
      }

      setEscuchando(false)
    }

    reconocimiento.onend = () => setEscuchando(false)

    reconocimientoRef.current = reconocimiento
    reconocimiento.start()
    setEscuchando(true)
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        gap: '6px',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <select
        value={idioma}
        onChange={(evento) => onIdioma(evento.target.value)}
        style={{
          padding: '8px',
          borderRadius: '10px',
          border: '1px solid #e0e0ee',
          fontSize: '14px',
        }}
      >
        {idiomas.map((opcion) => (
          <option key={opcion.codigo} value={opcion.codigo}>
            {opcion.nombre}
          </option>
        ))}
      </select>

      <button
        className="app-button app-button-secondary"
        type="button"
        onClick={alternar}
      >
        {escuchando ? '⏹️ Escoltant...' : '🎤 Dictar'}
      </button>
    </span>
  )
}

function colorPorcentaje(porcentaje: number) {
  if (porcentaje >= 70) {
    return '#2f9e6e'
  }

  if (porcentaje >= 40) {
    return '#6d5dfc'
  }

  return '#e5646e'
}

function BarraProgreso({ porcentaje }: { porcentaje: number }) {
  const valor = Math.max(0, Math.min(100, porcentaje))

  return (
    <div
      style={{
        height: '10px',
        borderRadius: '10px',
        background: '#ececf4',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${valor}%`,
          background: colorPorcentaje(valor),
        }}
      />
    </div>
  )
}

function fechaEnDias(dias: number) {
  const fecha = new Date()
  fecha.setDate(fecha.getDate() + dias)
  return fecha.toLocaleDateString('sv-SE')
}

const ESTILO_TARJETA: React.CSSProperties = {
  background: '#ffffff',
  borderRadius: '24px',
  padding: '24px',
  boxShadow: '0 10px 40px rgba(109, 93, 252, 0.10)',
}

const ESTILO_SELECT: React.CSSProperties = {
  width: '100%',
  padding: '12px',
  borderRadius: '12px',
  border: '1px solid #e0e0ee',
  fontSize: '15px',
}

function AppInterna() {
  const [pantalla, setPantalla] = useState('inicio')

  // ----- Sesión (login) -----
const [sesion, setSesion] = useState<Session | null>(null)
const [cargandoSesion, setCargandoSesion] = useState(true)
const [emailLogin, setEmailLogin] = useState('')
const [passwordLogin, setPasswordLogin] = useState('')
const [errorLogin, setErrorLogin] = useState('')
const [iniciandoSesion, setIniciandoSesion] = useState(false)
const [cargandoDatos, setCargandoDatos] = useState(true)
const [estadoServidor, setEstadoServidor] = useState<'ok' | 'servidor' | 'ollama'>('ok')

const usuarioId = sesion?.user.id ?? null


// Emojis que llevas puestos sobre la foto (guardados en tu cuenta)
const complementos: string[] = Array.isArray(
  sesion?.user.user_metadata?.complementos,
)
  ? (sesion?.user.user_metadata.complementos as string[])
  : []

useEffect(() => {
  supabase.auth.getSession().then(({ data }) => {
    setSesion(data.session)
    setCargandoSesion(false)
  })

  const { data: suscripcion } = supabase.auth.onAuthStateChange(
    (_evento, nuevaSesion) => {
      setSesion(nuevaSesion)
    },
  )

  return () => suscripcion.subscription.unsubscribe()
}, [])

const [avisoCerrado, setAvisoCerrado] = useState(false)

// Comprobar cada 30 s que el servidor de IA y Ollama están encendidos
// (el aviso solo sale tras 2 fallos seguidos, para evitar falsas alarmas)
useEffect(() => {
  let fallosSeguidos = 0

  async function comprobar() {
    const controlador = new AbortController()
    const temporizador = setTimeout(() => controlador.abort(), 8000)

    try {
      const respuesta = await fetch(API_IA + '/estado', {
        signal: controlador.signal,
      })

      const datos = await respuesta.json()

      fallosSeguidos = 0
      setEstadoServidor(datos.ollama ? 'ok' : 'ollama')

      if (datos.ollama) {
        setAvisoCerrado(false)
      }
    } catch (error) {
      fallosSeguidos++

      if (fallosSeguidos >= 2) {
        setEstadoServidor('servidor')
      }
    } finally {
      clearTimeout(temporizador)
    }
  }

  comprobar()

  const intervalo = setInterval(comprobar, 30000)

  return () => clearInterval(intervalo)
}, [])

        console.log('PANTALLA:', pantalla)

  const [asignaturaSeleccionadaId, setAsignaturaSeleccionadaId] =
    useState<number | null>(null) 

  const [asignaturaSeleccionada, setAsignaturaSeleccionada] =
    useState<string | null>(null)

  const [temaSeleccionado, setTemaSeleccionado] =
    useState<Topic | null>(null)

  const [temas, setTemas] = useState<Topic[]>([])

  const [ejercicios, setEjercicios] = useState<
    {
      id: number
      titulo: string
      enunciado: string
      tipo: string
      dificultad: string
      xp: number
    }[]
    
  >([])

  const [corrigiendoRespuesta, setCorrigiendoRespuesta] = useState<number | null>(null)
  const [generandoEjercicios, setGenerandoEjercicios] = useState<number | null>(null)
  const [generandoPrincipal, setGenerandoPrincipal] = useState(false)
    const [eliminandoEjercicio, setEliminandoEjercicio] = useState<number | null>(null)

    const [recomendaciones, setRecomendaciones] = useState<
  {
    nombre: string
    errores: number
    aciertos: number
  }[]
>([])

const [recomendacionIA, setRecomendacionIA] =
  useState('')

  useEffect(() => {
  console.log('ESTADO RECOMENDACIÓN IA:', recomendacionIA)
}, [recomendacionIA])

  const [materialPdfSeleccionado, setMaterialPdfSeleccionado] =
  useState<string | null>(null)

  const [respuestas, setRespuestas] = useState<{
    [ejercicioId: number]: string
  }>({})

  const [correcciones, setCorrecciones] = useState<{
    [ejercicioId: number]: {
      correcta: boolean
      xp_ganada: number
      comentario: string | null
      intento: number
      solucion?: string
    }
  }>({})

  const [cargandoTemas, setCargandoTemas] = useState(false)
  const [errorTemas, setErrorTemas] = useState<string | null>(null)

  const [mostrarFormularioTema, setMostrarFormularioTema] =
    useState(false)

  const [nombreNuevoTema, setNombreNuevoTema] = useState('')

  const [editandoNombre, setEditandoNombre] = useState(false)
  const [nombreTemaEditado, setNombreTemaEditado] = useState('')

  const [subiendoPdf, setSubiendoPdf] = useState(false)

  const [xp, setXp] = useState(0)

  const [ejerciciosCompletados, setEjerciciosCompletados] = useState(0)

  const [ejerciciosCorrectos, setEjerciciosCorrectos] = useState(0)
const [ejerciciosIncorrectos, setEjerciciosIncorrectos] = useState(0)

const [progresoAsignaturas, setProgresoAsignaturas] = useState<
  {
    nombre: string
    total: number
    completados: number
  }[]
>([])

const [progresoTemas, setProgresoTemas] = useState<
  {
    id: number
    nombre: string
    asignatura: string
    correctas: number
    incorrectas: number
    dificultad: string | null
  }[]
>([])

const [estadisticas, setEstadisticas] = useState({
  porcentajeAcierto: 0,
  xpTotal: 0,
  xpMedia: 0,
  intentosMedios: 0,
  asignaturaMas: '—',
  asignaturaMenos: '—',
})

const [evolucion, setEvolucion] = useState<
  {
    dia: string
    correctas: number
    errores: number
  }[]
>([])

const [nivelSubido, setNivelSubido] = useState<number | null>(null)

const nivelAnteriorRef = useRef<number | null>(null)

const [problemasRecurrentes, setProblemasRecurrentes] = useState<
  {
    id: number
    nombre: string
    asignatura: string
    fallos: number
    total: number
  }[]
>([])

const [generandoRefuerzo, setGenerandoRefuerzo] = useState<number | null>(null)

const [erroresRepaso, setErroresRepaso] = useState<
  {
    clave: string
    enunciado: string
    temaId: number
    temaNombre: string
    asignatura: string
    materialId: number | null
    fallos: number
  }[]
>([])

const [repasoActivo, setRepasoActivo] = useState<{
  clave: string
  cargando: boolean
  explicacion: string
} | null>(null)

const [generandoPractica, setGenerandoPractica] = useState<string | null>(null)

const [mensajesChat, setMensajesChat] = useState<
  { rol: 'usuario' | 'ia'; texto: string }[]
>([])

const [textoChat, setTextoChat] = useState('')
const [escribiendoChat, setEscribiendoChat] = useState(false)
const [temaChatId, setTemaChatId] = useState<number | null>(null)
const [contextoChat, setContextoChat] = useState('')
const [cargandoContextoChat, setCargandoContextoChat] = useState(false)

const finChatRef = useRef<HTMLDivElement | null>(null)

useEffect(() => {
  finChatRef.current?.scrollIntoView({ behavior: 'smooth' })
}, [mensajesChat, escribiendoChat])

// Cargar el historial del chat al abrir la app
useEffect(() => {
  if (!usuarioId) {
    return
  }

  cargarHistorialChat()
}, [usuarioId])

// ----- Flashcards -----
const [temaFlashId, setTemaFlashId] = useState<number | null>(null)
const [estadoTarjetas, setEstadoTarjetas] = useState({ total: 0, hoy: 0 })
const [generandoTarjetas, setGenerandoTarjetas] = useState(false)
const [sesionTarjetasActiva, setSesionTarjetasActiva] = useState(false)
const [colaTarjetas, setColaTarjetas] = useState<Tarjeta[]>([])
const [totalSesionTarjetas, setTotalSesionTarjetas] = useState(0)
const [tarjetasSabidas, setTarjetasSabidas] = useState(0)
const [respuestaVisible, setRespuestaVisible] = useState(false)

useEffect(() => {
  if (pantalla === 'flashcards') {
    contarTarjetas(temaFlashId)
  }

    if (pantalla === 'estudio' || pantalla === 'inicio') {
    contarTarjetas(null)
  }
}, [pantalla, temaFlashId, usuarioId])

// ----- Examen -----
const [temaExamenId, setTemaExamenId] = useState<number | null>(null)
const [numPreguntasExamen, setNumPreguntasExamen] = useState(10)
const [preparandoExamen, setPreparandoExamen] = useState(false)
const [examen, setExamen] = useState<EstadoExamen | null>(null)


// ----- Simulacro (examen de 1 hora) -----
const [modoExamen, setModoExamen] = useState<'normal' | 'simulacro'>('normal')
const [ahoraMs, setAhoraMs] = useState(Date.now())

const [historialExamenes, setHistorialExamenes] = useState<
  { fecha: string; nota: number; modo: string }[]
>([])

const segundosRestantes =
  examen && examen.finMs
    ? Math.max(0, Math.round((examen.finMs - ahoraMs) / 1000))
    : null

// Cuenta atrás del simulacro
useEffect(() => {
  if (examen?.fase !== 'respondiendo' || !examen.finMs) {
    return
  }

  setAhoraMs(Date.now())

  const intervalo = setInterval(() => setAhoraMs(Date.now()), 1000)

  return () => clearInterval(intervalo)
}, [examen?.fase, examen?.finMs])

// Al llegar a 0, el simulacro se entrega solo
useEffect(() => {
  if (examen?.fase === 'respondiendo' && segundosRestantes === 0) {
    finalizarExamen()
  }
}, [segundosRestantes, examen?.fase])

// Cargar el historial de notas al abrir la pantalla de examen
useEffect(() => {
  if (pantalla === 'examen' && usuarioId) {
    cargarHistorialExamenes()
  }
}, [pantalla, usuarioId])

// ----- Pomodoro -----
const [pomoFase, setPomoFase] = useState<'parado' | 'foco' | 'descanso'>('parado')
const [pomoFinMs, setPomoFinMs] = useState(0)
const [pomoAhoraMs, setPomoAhoraMs] = useState(Date.now())
const [pomoDuracionSeg, setPomoDuracionSeg] = useState(25 * 60)
const [pomoCiclos, setPomoCiclos] = useState(0)
const [resumenPomodoro, setResumenPomodoro] = useState({ hoy: 0, total: 0 })

const [presetPomodoro, setPresetPomodoro] =
  useState<keyof typeof PRESETS_POMODORO>('25-5')

const tituloOriginalRef = useRef(document.title)


// ----- Anglès Professional y dictado -----
const [idiomaDictado, setIdiomaDictado] = useState(
  () => localStorage.getItem('idiomaDictado') ?? 'es-ES',
)

const [idiomaIngles, setIdiomaIngles] = useState('en-US')

const [pestanaIngles, setPestanaIngles] = useState<
  'vocabulario' | 'redaccion' | 'pronunciacion'
>('vocabulario')

const [temaInglesId, setTemaInglesId] = useState<number | null>(null)
const [temaVocabulario, setTemaVocabulario] = useState('')
const [idiomaTraduccion, setIdiomaTraduccion] = useState('català')
const [generandoVocabulario, setGenerandoVocabulario] = useState(false)

const [vocabularioNuevo, setVocabularioNuevo] = useState<
  { termino: string; traduccion: string; ejemplo: string }[]
>([])

const [tipoRedaccion, setTipoRedaccion] = useState('email')
const [textoRedaccion, setTextoRedaccion] = useState('')
const [corrigiendoRedaccion, setCorrigiendoRedaccion] = useState(false)

const [resultadoRedaccion, setResultadoRedaccion] =
  useState<ResultadoRedaccion | null>(null)

const [fraseObjetivo, setFraseObjetivo] = useState(FRASES_INGLES[0])

const [resultadoPronunciacion, setResultadoPronunciacion] = useState<
  ReturnType<typeof compararPronunciacion> | null
>(null)

useEffect(() => {
  localStorage.setItem('idiomaDictado', idiomaDictado)
}, [idiomaDictado])

// Al entrar en la sección, se elige solo un tema de Anglès (si existe)
useEffect(() => {
  if (pantalla !== 'ingles' || temaInglesId !== null || progresoTemas.length === 0) {
    return
  }

  const deIngles = progresoTemas.find((tema) =>
    tema.asignatura.toLowerCase().includes('angl'),
  )

  if (deIngles) {
    setTemaInglesId(deIngles.id)
  }
}, [pantalla, progresoTemas])


// ----- Visor de PDF -----
const [materialVisor, setMaterialVisor] = useState<Material | null>(null)
const [paginaVisor, setPaginaVisor] = useState(1)
const [totalPaginasVisor, setTotalPaginasVisor] = useState(0)
const [zoomVisor, setZoomVisor] = useState(1)
const [cargandoVisor, setCargandoVisor] = useState(false)
const [pdfListoVisor, setPdfListoVisor] = useState(false)
const [errorVisor, setErrorVisor] = useState('')
const [redimVisor, setRedimVisor] = useState(0)
const [subrayadosVisor, setSubrayadosVisor] = useState<SubrayadoVisor[]>([])
const [marcadoresVisor, setMarcadoresVisor] = useState<MarcadorVisor[]>([])
const [colorSubrayado, setColorSubrayado] = useState('amarillo')

const [panelVisor, setPanelVisor] =
  useState<'subrayados' | 'marcadores' | 'ia'>('subrayados')

const [preguntaVisor, setPreguntaVisor] = useState('')
const [respuestaIAVisor, setRespuestaIAVisor] = useState('')
const [preguntandoVisor, setPreguntandoVisor] = useState(false)

const pdfDocVisorRef = useRef<any>(null)
const tareaDocVisorRef = useRef<any>(null)
const renderVisorRef = useRef<any>(null)
const contenedorVisorRef = useRef<HTMLDivElement | null>(null)
const paginaDivVisorRef = useRef<HTMLDivElement | null>(null)
const canvasVisorRef = useRef<HTMLCanvasElement | null>(null)
const capaTextoVisorRef = useRef<HTMLDivElement | null>(null)

// Descargar y abrir el PDF cuando se entra en el visor
useEffect(() => {
  if (pantalla !== 'visor' || !materialVisor || !usuarioId) {
    return
  }

  const material = materialVisor
  let cancelado = false

  setCargandoVisor(true)
  setPdfListoVisor(false)
  setErrorVisor('')
  setRespuestaIAVisor('')
  setZoomVisor(1)

  async function abrir() {
    try {
      const url = await urlTemporalPdf(material.path)
      const respuesta = await fetch(url)

      if (!respuesta.ok) {
        throw new Error('No se ha podido descargar el PDF.')
      }

      const bytes = new Uint8Array(await respuesta.arrayBuffer())
            const tareaDocumento = pdfjsLib.getDocument({ data: bytes })
      tareaDocVisorRef.current = tareaDocumento
      const documento = await tareaDocumento.promise

      if (cancelado) {
        tareaDocumento.destroy()
        return
      }

      pdfDocVisorRef.current = documento
      setTotalPaginasVisor(documento.numPages)

      const guardada = Number(
        localStorage.getItem(`visorPagina:${material.id}`) ?? 1,
      )

      setPaginaVisor(
        guardada >= 1 && guardada <= documento.numPages ? guardada : 1,
      )

      const { data: subrayados } = await supabase
        .from('pdf_subrayados')
        .select('id, pagina, rects, texto, color')
        .eq('material_id', material.id)
        .order('id', { ascending: true })

      const { data: marcadores } = await supabase
        .from('pdf_marcadores')
        .select('id, pagina, nota')
        .eq('material_id', material.id)
        .order('pagina', { ascending: true })

      if (cancelado) {
        return
      }

      setSubrayadosVisor((subrayados ?? []) as SubrayadoVisor[])
      setMarcadoresVisor((marcadores ?? []) as MarcadorVisor[])
      setPdfListoVisor(true)
    } catch (error) {
      console.error('Error abriendo el PDF en el visor:', error)

      if (!cancelado) {
        setErrorVisor("No s'ha pogut obrir el PDF en el visor.")
      }
    } finally {
      if (!cancelado) {
        setCargandoVisor(false)
      }
    }
  }

  abrir()

  return () => {
    cancelado = true
    renderVisorRef.current?.cancel()
        tareaDocVisorRef.current?.destroy()
    tareaDocVisorRef.current = null
    pdfDocVisorRef.current = null
  }
}, [pantalla, materialVisor?.id, usuarioId])

// Dibujar la página actual (imagen + capa de texto seleccionable)
useEffect(() => {
  if (pantalla !== 'visor' || !pdfListoVisor) {
    return
  }

  let cancelado = false

  async function dibujar() {
    const pdf = pdfDocVisorRef.current
    const canvas = canvasVisorRef.current
    const capaTexto = capaTextoVisorRef.current
    const contenedor = contenedorVisorRef.current
    const paginaDiv = paginaDivVisorRef.current

    if (!pdf || !canvas || !capaTexto || !contenedor || !paginaDiv) {
      return
    }

    const pagina = await pdf.getPage(paginaVisor)
    const base = pagina.getViewport({ scale: 1 })
    const anchoDisponible = Math.max(280, contenedor.clientWidth - 16)
    const escala = (anchoDisponible / base.width) * zoomVisor
    const viewport = pagina.getViewport({ scale: escala })
    const dpr = window.devicePixelRatio || 1

    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width = `${Math.floor(viewport.width)}px`
    canvas.style.height = `${Math.floor(viewport.height)}px`

    paginaDiv.style.width = canvas.style.width
    paginaDiv.style.height = canvas.style.height
    paginaDiv.style.setProperty('--scale-factor', String(escala))
    paginaDiv.style.setProperty('--total-scale-factor', String(escala))
    paginaDiv.style.setProperty('--user-unit', '1')

    renderVisorRef.current?.cancel()

    const contexto = canvas.getContext('2d')

    if (!contexto) {
      return
    }

    const tarea = pagina.render({
      canvasContext: contexto,
      canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    } as any)

    renderVisorRef.current = tarea

    try {
      await tarea.promise
    } catch (error) {
      return
    }

    if (cancelado) {
      return
    }

    capaTexto.replaceChildren()

    const capa = new pdfjsLib.TextLayer({
      textContentSource: pagina.streamTextContent(),
      container: capaTexto,
      viewport,
    })

    await capa.render()
  }

  dibujar().catch((error) => {
    console.error('Error dibujando la página del PDF:', error)
  })

  return () => {
    cancelado = true
  }
}, [pantalla, pdfListoVisor, paginaVisor, zoomVisor, redimVisor])

// Redibujar al girar el móvil o cambiar el tamaño de la ventana
useEffect(() => {
  if (pantalla !== 'visor') {
    return
  }

  let temporizador: number | undefined

  function alCambiar() {
    window.clearTimeout(temporizador)
    temporizador = window.setTimeout(() => setRedimVisor((n) => n + 1), 250)
  }

  window.addEventListener('resize', alCambiar)

  return () => {
    window.clearTimeout(temporizador)
    window.removeEventListener('resize', alCambiar)
  }
}, [pantalla])

// Cambiar de página con las flechas del teclado
useEffect(() => {
  if (pantalla !== 'visor') {
    return
  }

  function alPulsar(evento: KeyboardEvent) {
    const destino = evento.target as HTMLElement

    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(destino.tagName)) {
      return
    }

    if (evento.key === 'ArrowRight') {
      cambiarPaginaVisor(1)
    }

    if (evento.key === 'ArrowLeft') {
      cambiarPaginaVisor(-1)
    }
  }

  window.addEventListener('keydown', alPulsar)

  return () => window.removeEventListener('keydown', alPulsar)
}, [pantalla, paginaVisor, totalPaginasVisor])

// Recordar por qué página ibas en cada PDF
useEffect(() => {
  if (pantalla === 'visor' && materialVisor && pdfListoVisor) {
    localStorage.setItem(`visorPagina:${materialVisor.id}`, String(paginaVisor))
  }
}, [pantalla, materialVisor?.id, pdfListoVisor, paginaVisor])

// ----- Apuntes -----
const [temaApuntesId, setTemaApuntesId] = useState<number | null>(null)

const [apuntes, setApuntes] = useState<{
  contenido: string
  actualizado: string
} | null>(null)

const [editandoApuntes, setEditandoApuntes] = useState(false)
const [borradorApuntes, setBorradorApuntes] = useState('')
const [generandoApuntes, setGenerandoApuntes] = useState(false)
const [progresoApuntes, setProgresoApuntes] = useState({ actual: 0, total: 0 })

useEffect(() => {
  if (pantalla !== 'apuntes') {
    return
  }

  if (temaApuntesId && usuarioId) {
    cargarApuntes(temaApuntesId)
  } else {
    setApuntes(null)
  }
}, [pantalla, temaApuntesId, usuarioId])

// ----- Plan de estudio -----
const [temaPlanId, setTemaPlanId] = useState<number | null>(null)
const [fechaExamenPlan, setFechaExamenPlan] = useState('')

const [plan, setPlan] = useState<{
  fechaExamen: string
  tareas: TareaPlan[]
} | null>(null)

const [generandoPlan, setGenerandoPlan] = useState(false)
const [soloSemana, setSoloSemana] = useState(true)

useEffect(() => {
  if (pantalla !== 'plan') {
    return
  }

  if (temaPlanId && usuarioId) {
    cargarPlan(temaPlanId)
  } else {
    setPlan(null)
  }
}, [pantalla, temaPlanId, usuarioId])

const pomoRestante =
  pomoFase === 'parado'
    ? 0
    : Math.max(0, Math.round((pomoFinMs - pomoAhoraMs) / 1000))

useEffect(() => {
  if (pomoFase === 'parado') {
    return
  }

  setPomoAhoraMs(Date.now())

  const intervalo = setInterval(() => setPomoAhoraMs(Date.now()), 1000)

  return () => clearInterval(intervalo)
}, [pomoFase])

useEffect(() => {
  if (pomoFase !== 'parado' && pomoRestante === 0) {
    terminarFasePomodoro()
  }
}, [pomoRestante, pomoFase])

// El tiempo que queda se ve también en la pestaña del navegador
useEffect(() => {
  if (pomoFase === 'parado') {
    document.title = tituloOriginalRef.current
    return
  }

  document.title = `${pomoFase === 'foco' ? '🍅' : '☕'} ${formatoTiempo(pomoRestante)}`
}, [pomoFase, pomoRestante])

async function cargarHistorialExamenes() {
  const { data, error } = await supabase
    .from('examenes_historial')
    .select('total, aciertos, modo, created_at')
    .order('id', { ascending: false })
    .limit(20)

  if (error) {
    console.error('Error cargando el historial de exámenes:', error)
    return
  }

  setHistorialExamenes(
    (data ?? []).reverse().map((fila) => ({
      fecha: new Date(fila.created_at).toLocaleDateString('ca-ES', {
        day: 'numeric',
        month: 'short',
      }),
      nota:
        fila.total === 0 ? 0 : Math.round((fila.aciertos / fila.total) * 100),
      modo: fila.modo,
    })),
  )
}

function iniciarPomodoro() {
  const preset = PRESETS_POMODORO[presetPomodoro]
  const ahora = Date.now()

  prepararAudio()

  setPomoDuracionSeg(preset.foco * 60)
  setPomoAhoraMs(ahora)
  setPomoFinMs(ahora + preset.foco * 60000)
  setPomoFase('foco')
}

function detenerPomodoro() {
  setPomoFase('parado')
}

async function terminarFasePomodoro() {
  const preset = PRESETS_POMODORO[presetPomodoro]

  sonarAviso()

  if (pomoFase !== 'foco') {
    setPomoFase('parado')
    return
  }

  const xpGanada = resumenPomodoro.hoy < MAX_POMODOROS_XP_DIA ? preset.xp : 0
  const ciclo = pomoCiclos + 1
  const minutosDescanso = ciclo % 4 === 0 ? preset.descansoLargo : preset.descanso
  const ahora = Date.now()

  // Se pasa al descanso al momento y después se guarda la sesión
  setPomoCiclos(ciclo)
  setPomoDuracionSeg(minutosDescanso * 60)
  setPomoAhoraMs(ahora)
  setPomoFinMs(ahora + minutosDescanso * 60000)
  setPomoFase('descanso')

  const { error } = await supabase
    .from('pomodoros')
    .insert({ minutos: preset.foco, xp: xpGanada })

  if (error) {
    console.error('Error guardando el pomodoro:', error)
  }

  await cargarProgreso()
}

// ----- Apuntes -----
async function cargarApuntes(temaId: number) {
  const { data, error } = await supabase
    .from('apuntes')
    .select('contenido, updated_at')
    .eq('tema_id', temaId)
    .maybeSingle()

  if (error) {
    console.error('Error cargando los apuntes:', error)
    return
  }

  setApuntes(
    data ? { contenido: data.contenido, actualizado: data.updated_at } : null,
  )

  setEditandoApuntes(false)
}

async function generarApuntes() {
  if (!temaApuntesId) {
    return
  }

  if (
    apuntes &&
    !window.confirm(
      'Ja tens apunts d\'aquest tema. Vols generar-ne de nous i substituir-los?',
    )
  ) {
    return
  }

  setGenerandoApuntes(true)
  setProgresoApuntes({ actual: 0, total: 0 })

  try {
    const texto = await obtenerTextoCompletoDelTema(temaApuntesId)
    const bloques = dividirEnBloques(texto)

    if (bloques.length === 0) {
      window.alert('Aquest tema no té text als PDFs.')
      return
    }

    const nombreTema =
      progresoTemas.find((tema) => tema.id === temaApuntesId)?.nombre ?? ''

    const secciones: string[] = []

    for (let i = 0; i < bloques.length; i++) {
      setProgresoApuntes({ actual: i + 1, total: bloques.length })

      try {
        const respuesta = await fetch(API_IA + '/generar-apuntes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texto: bloques[i], nombreTema }),
        })

        if (!respuesta.ok) {
          throw new Error(`El servidor respondió ${respuesta.status}`)
        }

        const seccion = await respuesta.json()

        const lineas = [
          `## ${seccion.titulo}`,
          ...seccion.puntos.map((punto: string) => `- ${punto}`),
          ...seccion.definiciones.map(
            (definicion: { termino: string; definicion: string }) =>
              `- ${definicion.termino}: ${definicion.definicion}`,
          ),
          '',
        ]

        secciones.push(lineas.join('\n'))
      } catch (errorBloque) {
        console.error('Error resumiendo un bloque:', errorBloque)
      }
    }

    if (secciones.length === 0) {
      throw new Error("No s'ha pogut generar cap apartat.")
    }

    const { error } = await supabase.from('apuntes').upsert(
      {
        tema_id: temaApuntesId,
        contenido: secciones.join('\n').trim(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tema_id' },
    )

    if (error) {
      throw error
    }

    await cargarApuntes(temaApuntesId)
  } catch (error) {
    console.error('Error generando los apuntes:', error)

    window.alert("No s'han pogut generar els apunts. Mira que el servidor i Ollama estiguin encesos.")
  } finally {
    setGenerandoApuntes(false)
  }
}

async function guardarEdicionApuntes() {
  if (!temaApuntesId) {
    return
  }

  const { error } = await supabase
    .from('apuntes')
    .update({
      contenido: borradorApuntes,
      updated_at: new Date().toISOString(),
    })
    .eq('tema_id', temaApuntesId)

  if (error) {
    console.error('Error guardando los apuntes:', error)
    window.alert("No s'han pogut guardar els apunts.")
    return
  }

  await cargarApuntes(temaApuntesId)
}

async function borrarApuntes() {
  if (!temaApuntesId || !window.confirm('Segur que vols esborrar els apunts?')) {
    return
  }

  const { error } = await supabase
    .from('apuntes')
    .delete()
    .eq('tema_id', temaApuntesId)

  if (error) {
    console.error('Error borrando los apuntes:', error)
    window.alert("No s'han pogut esborrar els apunts.")
    return
  }

  setApuntes(null)
}

function descargarApuntesPdf() {
  if (!apuntes || !temaApuntesId) {
    return
  }

  const temaDelApunte = progresoTemas.find((tema) => tema.id === temaApuntesId)

  const doc = crearPdfApuntes(
    `Apunts: ${temaDelApunte?.nombre ?? ''}`,
    `${temaDelApunte?.asignatura ?? ''} · ${new Date().toLocaleDateString('ca-ES')}`,
    apuntes.contenido,
  )

  const nombreArchivo = (temaDelApunte?.nombre ?? 'tema')
    .replace(/[^a-zA-Z0-9À-ÿ]+/g, '-')
    .toLowerCase()

  doc.save(`apunts-${nombreArchivo}.pdf`)
}

async function anadirApuntesComoPdf() {
  if (!apuntes || !temaApuntesId) {
    return
  }

  const temaDelApunte = progresoTemas.find((tema) => tema.id === temaApuntesId)

  const doc = crearPdfApuntes(
    `Apunts: ${temaDelApunte?.nombre ?? ''}`,
    `${temaDelApunte?.asignatura ?? ''} · ${new Date().toLocaleDateString('ca-ES')}`,
    apuntes.contenido,
  )

  const archivo = new File(
    [doc.output('blob')],
    `Apunts - ${temaDelApunte?.nombre ?? 'tema'}.pdf`,
    { type: 'application/pdf' },
  )

  const material = await subirArchivo(archivo, temaApuntesId, 'adicional')

  if (!material) {
    window.alert("No s'ha pogut afegir el PDF al tema.")
    return
  }

  window.alert(
    "PDF afegit als PDFs addicionals del tema. Obre el tema de nou per veure'l.",
  )
}

// ----- Plan de estudio -----
async function cargarPlan(temaId: number) {
  const { data, error } = await supabase
    .from('planes_estudio')
    .select('fecha_examen, tareas')
    .eq('tema_id', temaId)
    .maybeSingle()

  if (error) {
    console.error('Error cargando el plan:', error)
    return
  }

  if (data) {
    setPlan({
      fechaExamen: data.fecha_examen,
      tareas: (data.tareas ?? []) as TareaPlan[],
    })

    setFechaExamenPlan(data.fecha_examen)
  } else {
    setPlan(null)
    setFechaExamenPlan('')
  }
}

async function generarPlan() {
  if (!temaPlanId || !fechaExamenPlan) {
    window.alert("Tria un tema i la data de l'examen.")
    return
  }

  const hoy = fechaEnDias(0)

  if (fechaExamenPlan < hoy) {
    window.alert("La data de l'examen ha de ser avui o més endavant.")
    return
  }

  if (
    plan &&
    !window.confirm(
      'Això substituirà el pla actual (es perdrà el que has marcat). Continuar?',
    )
  ) {
    return
  }

  setGenerandoPlan(true)

  try {
    const temaDelPlan = progresoTemas.find((tema) => tema.id === temaPlanId)

    const respuestasDelTema = temaDelPlan
      ? temaDelPlan.correctas + temaDelPlan.incorrectas
      : 0

    const { count: numApuntes } = await supabase
      .from('apuntes')
      .select('id', { count: 'exact', head: true })
      .eq('tema_id', temaPlanId)

    const { count: numTarjetas } = await supabase
      .from('flashcards')
      .select('id', { count: 'exact', head: true })
      .eq('tema_id', temaPlanId)

    const tareas = construirPlan({
      hoy,
      fechaExamen: fechaExamenPlan,
      acierto:
        temaDelPlan && respuestasDelTema >= 3
          ? (temaDelPlan.correctas / respuestasDelTema) * 100
          : null,
      erroresPendientes: erroresRepaso.filter(
        (item) => item.temaId === temaPlanId,
      ).length,
      problemaRecurrente: problemasRecurrentes.some(
        (problema) => problema.id === temaPlanId,
      ),
      tieneApuntes: (numApuntes ?? 0) > 0,
      tarjetas: numTarjetas ?? 0,
    })

    const { error } = await supabase.from('planes_estudio').upsert(
      { tema_id: temaPlanId, fecha_examen: fechaExamenPlan, tareas },
      { onConflict: 'tema_id' },
    )

    if (error) {
      throw error
    }

    setPlan({ fechaExamen: fechaExamenPlan, tareas })
  } catch (error) {
    console.error('Error generando el plan:', error)

    window.alert("No s'ha pogut generar el pla.")
  } finally {
    setGenerandoPlan(false)
  }
}

async function alternarTareaPlan(tareaId: string) {
  if (!plan || !temaPlanId) {
    return
  }

  const tareas = plan.tareas.map((tarea) =>
    tarea.id === tareaId ? { ...tarea, hecho: !tarea.hecho } : tarea,
  )

  setPlan({ ...plan, tareas })

  const { error } = await supabase
    .from('planes_estudio')
    .update({ tareas })
    .eq('tema_id', temaPlanId)

  if (error) {
    console.error('Error guardando la tarea:', error)
  }
}

async function eliminarPlan() {
  if (!temaPlanId || !window.confirm('Segur que vols esborrar el pla?')) {
    return
  }

  const { error } = await supabase
    .from('planes_estudio')
    .delete()
    .eq('tema_id', temaPlanId)

  if (error) {
    console.error('Error borrando el plan:', error)
    window.alert("No s'ha pogut esborrar el pla.")
    return
  }

  setPlan(null)
  setFechaExamenPlan('')
}

// Lleva a la pantalla que corresponde a cada tarea del plan
function irATarea(tarea: TareaPlan) {
  const temaId = temaPlanId

  if (!temaId) {
    return
  }

  switch (tarea.tipo) {
    case 'teoria':
    case 'ejercicios':
      abrirTemaPendiente(temaId)
      break
    case 'apuntes':
      setTemaApuntesId(temaId)
      setPantalla('apuntes')
      break
    case 'flashcards':
      setTemaFlashId(temaId)
      setPantalla('flashcards')
      break
    case 'refuerzo':
      practicarTemaDebil(temaId)
      break
    case 'errores':
      setPantalla('repaso')
      break
    case 'examen':
      setExamen(null)
      setTemaExamenId(temaId)
      setModoExamen('normal')
      setNumPreguntasExamen(10)
      setPantalla('examen')
      break
    case 'simulacro':
      setExamen(null)
      setTemaExamenId(temaId)
      setModoExamen('simulacro')
      setNumPreguntasExamen(20)
      setPantalla('examen')
      break
    case 'pomodoro':
      setPantalla('pomodoro')
      break
    case 'ia':
      seleccionarTemaChat(String(temaId))
      setPantalla('ia')
      break
    default:
      break
  }
}

// ----- Visor de PDF -----
async function abrirPdfEnPestana(material: Material) {
  // Se abre la pestaña al momento para que el móvil no la bloquee
  const ventana = window.open('', '_blank')

  try {
    const url = await urlTemporalPdf(material.path)

    if (ventana) {
      ventana.location.href = url
    } else {
      window.location.href = url
    }
  } catch (error) {
    ventana?.close()

    console.error('Error abriendo el PDF:', error)

    window.alert('No se ha podido abrir el PDF.')
  }
}

function cambiarPaginaVisor(delta: number) {
  setPaginaVisor((actual) =>
    Math.min(totalPaginasVisor, Math.max(1, actual + delta)),
  )
}

async function subrayarSeleccion() {
  const seleccion = window.getSelection()
  const paginaDiv = paginaDivVisorRef.current

  if (
    !seleccion ||
    seleccion.rangeCount === 0 ||
    seleccion.isCollapsed ||
    !paginaDiv ||
    !materialVisor
  ) {
    window.alert('Selecciona primer un tros de text de la pàgina.')
    return
  }

  const rango = seleccion.getRangeAt(0)

  if (!paginaDiv.contains(rango.commonAncestorContainer)) {
    window.alert('Selecciona text dins de la pàgina del PDF.')
    return
  }

  const caja = paginaDiv.getBoundingClientRect()

  const rects = Array.from(rango.getClientRects())
    .filter(
      (rect) =>
        rect.width > 1 && rect.height > 1 && rect.width < caja.width * 0.98,
    )
    .map((rect) => ({
      x: (rect.left - caja.left) / caja.width,
      y: (rect.top - caja.top) / caja.height,
      w: rect.width / caja.width,
      h: rect.height / caja.height,
    }))

  if (rects.length === 0) {
    window.alert("No s'ha pogut subratllar aquesta selecció.")
    return
  }

  const texto = seleccion.toString().replace(/\s+/g, ' ').trim().slice(0, 500)

  const { data, error } = await supabase
    .from('pdf_subrayados')
    .insert({
      material_id: materialVisor.id,
      pagina: paginaVisor,
      rects,
      texto,
      color: colorSubrayado,
    })
    .select('id, pagina, rects, texto, color')
    .single()

  if (error || !data) {
    console.error('Error guardando el subrayado:', error)
    window.alert("No s'ha pogut guardar el subratllat.")
    return
  }

  setSubrayadosVisor((actuales) => [...actuales, data as SubrayadoVisor])

  seleccion.removeAllRanges()
}

async function borrarSubrayado(id: number) {
  const { error } = await supabase.from('pdf_subrayados').delete().eq('id', id)

  if (error) {
    console.error('Error borrando el subrayado:', error)
    window.alert("No s'ha pogut esborrar el subratllat.")
    return
  }

  setSubrayadosVisor((actuales) =>
    actuales.filter((subrayado) => subrayado.id !== id),
  )
}

async function alternarMarcadorVisor() {
  if (!materialVisor) {
    return
  }

  const existente = marcadoresVisor.find(
    (marcador) => marcador.pagina === paginaVisor,
  )

  if (existente) {
    await borrarMarcadorVisor(existente.id)
    return
  }

  const nota = window.prompt('Nota per al marcador (opcional):', '')

  if (nota === null) {
    return
  }

  const { data, error } = await supabase
    .from('pdf_marcadores')
    .insert({
      material_id: materialVisor.id,
      pagina: paginaVisor,
      nota: nota.trim(),
    })
    .select('id, pagina, nota')
    .single()

  if (error || !data) {
    console.error('Error guardando el marcador:', error)
    window.alert("No s'ha pogut guardar el marcador.")
    return
  }

  setMarcadoresVisor((actuales) =>
    [...actuales, data as MarcadorVisor].sort((a, b) => a.pagina - b.pagina),
  )
}

async function borrarMarcadorVisor(id: number) {
  const { error } = await supabase.from('pdf_marcadores').delete().eq('id', id)

  if (error) {
    console.error('Error borrando el marcador:', error)
    window.alert("No s'ha pogut esborrar el marcador.")
    return
  }

  setMarcadoresVisor((actuales) =>
    actuales.filter((marcador) => marcador.id !== id),
  )
}

async function preguntarIAVisor(tipo: 'explicar' | 'resumir' | 'libre') {
  const pdf = pdfDocVisorRef.current

  if (!pdf) {
    return
  }

  // Se lee la selección antes de que nada la borre
  const seleccionada = window.getSelection()?.toString().trim() ?? ''

  setPreguntandoVisor(true)
  setRespuestaIAVisor('')

  try {
    const pagina = await pdf.getPage(paginaVisor)
    const contenido = await pagina.getTextContent()

    const textoPagina = contenido.items
      .map((item: any) => item.str ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (!textoPagina) {
      setRespuestaIAVisor(
        "Aquesta pàgina no té text (potser és una imatge escanejada), així que la IA no la pot llegir.",
      )
      return
    }

    let pregunta = ''

    if (tipo === 'explicar') {
      pregunta = seleccionada
        ? `Explica'm de manera senzilla aquest fragment: "${seleccionada.slice(0, 600)}"`
        : "Explica'm de manera senzilla el contingut d'aquesta pàgina."
    } else if (tipo === 'resumir') {
      pregunta = "Fes un resum curt amb els conceptes clau d'aquesta pàgina."
    } else {
      pregunta = preguntaVisor.trim()
    }

    if (!pregunta) {
      return
    }

    const respuesta = await fetch(API_IA + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mensajes: [{ rol: 'usuario', texto: pregunta }],
        contexto: textoPagina,
        nombreTema: materialVisor?.fileName ?? '',
        perfil: '',
        general: tipo !== 'libre',
      }),
    })

    if (!respuesta.ok) {
      throw new Error('El servidor no ha podido respondre.')
    }

    const datos = await respuesta.json()

    setRespuestaIAVisor(String(datos.respuesta ?? ''))
  } catch (error) {
    console.error('Error preguntando a la IA desde el visor:', error)

    setRespuestaIAVisor(
      'No he pogut respondre ara mateix. Comprova que el servidor i Ollama estan encesos.',
    )
  } finally {
    setPreguntandoVisor(false)
  }
}


// ----- Anglès Professional -----
async function generarVocabulario() {
  if (!temaInglesId || !temaVocabulario.trim()) {
    window.alert(
      'Tria un tema on guardar les targetes i escriu de què vols vocabulari.',
    )
    return
  }

  setGenerandoVocabulario(true)
  setVocabularioNuevo([])

  try {
    const { data: existentes } = await supabase
      .from('flashcards')
      .select('pregunta')
      .eq('tema_id', temaInglesId)

    const preguntasExistentes = (existentes ?? []).map(
      (fila) => fila.pregunta as string,
    )

    const respuesta = await fetch(API_IA + '/generar-vocabulario', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tema: temaVocabulario.trim(),
        idiomaTraduccion,
        cantidad: 10,
        existentes: preguntasExistentes,
      }),
    })

    if (!respuesta.ok) {
      throw new Error('El servidor no ha pogut generar el vocabulari.')
    }

    const datos = await respuesta.json()

    const nuevas: { termino: string; traduccion: string; ejemplo: string }[] = []

    for (const palabra of datos.palabras ?? []) {
      const yaExistentes = [
        ...preguntasExistentes,
        ...nuevas.map((nueva) => nueva.termino),
      ]

      if (esRepetido(palabra.termino, yaExistentes)) {
        continue
      }

      nuevas.push(palabra)
    }

    if (nuevas.length === 0) {
      window.alert('No hi ha paraules noves. Prova un altre tema.')
      return
    }

    const { data: temaDatos } = await supabase
      .from('temas')
      .select('asignatura_id')
      .eq('id', temaInglesId)
      .single()

    const { error } = await supabase.from('flashcards').insert(
      nuevas.map((nueva) => ({
        tema_id: temaInglesId,
        asignatura_id: temaDatos?.asignatura_id ?? null,
        pregunta: nueva.termino,
        respuesta: nueva.ejemplo
          ? `${nueva.traduccion} — ${nueva.ejemplo}`
          : nueva.traduccion,
      })),
    )

    if (error) {
      throw error
    }

    setVocabularioNuevo(nuevas)
  } catch (error) {
    console.error('Error generando vocabulario:', error)

    window.alert(
      "No s'ha pogut generar el vocabulari. Mira que el servidor i la IA estiguin actius.",
    )
  } finally {
    setGenerandoVocabulario(false)
  }
}

async function corregirRedaccion() {
  if (textoRedaccion.trim().length < 15) {
    window.alert('Escriu un text una mica més llarg.')
    return
  }

  setCorrigiendoRedaccion(true)
  setResultadoRedaccion(null)

  try {
    const respuesta = await fetch(API_IA + '/corregir-redaccion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: textoRedaccion, tipo: tipoRedaccion }),
    })

    if (!respuesta.ok) {
      throw new Error('El servidor no ha pogut corregir el text.')
    }

    setResultadoRedaccion((await respuesta.json()) as ResultadoRedaccion)
  } catch (error) {
    console.error('Error corrigiendo la redacción:', error)

    window.alert("No s'ha pogut corregir el text.")
  } finally {
    setCorrigiendoRedaccion(false)
  }
}

function evaluarPronunciacion(dicho: string) {
  setResultadoPronunciacion(compararPronunciacion(fraseObjetivo, dicho))
}

function siguienteFrase() {
  const otras = FRASES_INGLES.filter((frase) => frase !== fraseObjetivo)

  setFraseObjetivo(otras[Math.floor(Math.random() * otras.length)])
  setResultadoPronunciacion(null)
}

// ----- Reportar correcciones malas -----
async function guardarReporte(datos: {
  origen: string
  enunciado: string
  respuesta: string
  solucion?: string
  comentarioIA?: string
  correctaIA?: boolean | null
}) {
  const nota = window.prompt('Què ha fallat? (opcional)', '')

  if (nota === null) {
    return
  }

  const { error } = await supabase.from('reportes_correccion').insert({
    origen: datos.origen,
    enunciado: datos.enunciado,
    respuesta: datos.respuesta,
    solucion: datos.solucion ?? '',
    comentario_ia: datos.comentarioIA ?? '',
    correcta_ia: datos.correctaIA ?? null,
    nota: nota.trim(),
  })

  if (error) {
    console.error('Error guardando el reporte:', error)
    window.alert("No s'ha pogut guardar el report.")
    return
  }

  window.alert('Gràcies! Hem guardat la correcció per revisar-la.')
}

async function reportarCorreccionEjercicio(ejercicioId: number) {
  const { data } = await supabase
    .from('ejercicios')
    .select('enunciado, solucion')
    .eq('id', ejercicioId)
    .maybeSingle()

  const correccion = correcciones[ejercicioId]

  await guardarReporte({
    origen: 'ejercicio',
    enunciado: data?.enunciado ?? '',
    respuesta: respuestas[ejercicioId] ?? '',
    solucion: data?.solucion ?? '',
    comentarioIA: correccion?.comentario ?? '',
    correctaIA: correccion?.correcta ?? null,
  })
}

// ----- Importar y exportar flashcards -----
async function exportarTarjetas(formato: 'csv' | 'anki') {
  let consulta = supabase.from('flashcards').select('pregunta, respuesta')

  if (temaFlashId) {
    consulta = consulta.eq('tema_id', temaFlashId)
  }

  const { data, error } = await consulta.order('id', { ascending: true })

  if (error) {
    console.error('Error exportando las flashcards:', error)
    window.alert("No s'han pogut exportar les targetes.")
    return
  }

  const filas = data ?? []

  if (filas.length === 0) {
    window.alert('No hi ha targetes per exportar.')
    return
  }

  const limpiar = (texto: string) => String(texto).replace(/\s+/g, ' ').trim()

  const nombreTema =
    progresoTemas.find((tema) => tema.id === temaFlashId)?.nombre ?? 'totes'

  const nombreArchivo = `flashcards-${nombreTema}`
    .replace(/[^a-zA-Z0-9À-ÿ]+/g, '-')
    .toLowerCase()

  if (formato === 'csv') {
    const escapar = (texto: string) => `"${limpiar(texto).replace(/"/g, '""')}"`

    const contenido =
      '\uFEFF' +
      'pregunta,respuesta\r\n' +
      filas
        .map((fila) => `${escapar(fila.pregunta)},${escapar(fila.respuesta)}`)
        .join('\r\n')

    descargarArchivo(`${nombreArchivo}.csv`, contenido, 'text/csv;charset=utf-8')
  } else {
    const contenido =
      '#separator:tab\n#html:false\n' +
      filas
        .map((fila) => `${limpiar(fila.pregunta)}\t${limpiar(fila.respuesta)}`)
        .join('\n')

    descargarArchivo(`${nombreArchivo}.txt`, contenido, 'text/plain;charset=utf-8')
  }
}

async function importarTarjetas(event: React.ChangeEvent<HTMLInputElement>) {
  const archivo = event.target.files?.[0]

  event.target.value = ''

  if (!archivo) {
    return
  }

  if (!temaFlashId) {
    window.alert('Tria primer un tema on importar les targetes.')
    return
  }

  try {
    const texto = (await archivo.text()).replace(/^\uFEFF/, '')
    const filasLeidas = parsearCsv(texto)

    const cabecera = (filasLeidas[0] ?? []).map((celda) => celda.toLowerCase())

    const tieneCabecera = cabecera.some((celda) =>
      ['pregunta', 'question', 'front', 'anvers'].includes(celda),
    )

    const datos = tieneCabecera ? filasLeidas.slice(1) : filasLeidas

    const { data: existentes } = await supabase
      .from('flashcards')
      .select('pregunta')
      .eq('tema_id', temaFlashId)

    const preguntasExistentes = (existentes ?? []).map(
      (fila) => fila.pregunta as string,
    )

    const nuevas: { pregunta: string; respuesta: string }[] = []
    let repetidas = 0

    for (const celdas of datos) {
      const pregunta = celdas[0]?.trim()
      const respuesta = celdas[1]?.trim()

      if (!pregunta || !respuesta) {
        continue
      }

      const yaExistentes = [
        ...preguntasExistentes,
        ...nuevas.map((nueva) => nueva.pregunta),
      ]

      if (esRepetido(pregunta, yaExistentes)) {
        repetidas++
        continue
      }

      nuevas.push({ pregunta, respuesta })
    }

    if (nuevas.length === 0) {
      window.alert(
        `No hi ha targetes noves (${repetidas} repetides o buides al fitxer).`,
      )
      return
    }

    const { data: temaDatos } = await supabase
      .from('temas')
      .select('asignatura_id')
      .eq('id', temaFlashId)
      .single()

    const { error } = await supabase.from('flashcards').insert(
      nuevas.map((nueva) => ({
        tema_id: temaFlashId,
        asignatura_id: temaDatos?.asignatura_id ?? null,
        pregunta: nueva.pregunta,
        respuesta: nueva.respuesta,
      })),
    )

    if (error) {
      throw error
    }

    await contarTarjetas(temaFlashId)

    window.alert(
      `${nuevas.length} targetes importades${
        repetidas > 0 ? ` (${repetidas} repetides ignorades)` : ''
      }.`,
    )
  } catch (error) {
    console.error('Error importando las flashcards:', error)

    window.alert("No s'ha pogut importar el fitxer.")
  }
}

const aciertosExamen = examen
  ? examen.resultados.filter((resultado) => resultado.correcta).length
  : 0

// ----- Gamificación -----
const [objetivoHoy, setObjetivoHoy] = useState({ ejercicios: 0, xp: 0 })
const [rachaDias, setRachaDias] = useState(0)

const [logros, setLogros] = useState<CadenaLogro[]>([])

// Todos los emojis que has desbloqueado
const emojisDesbloqueados = logros.flatMap((cadena) =>
  cadena.niveles
    .filter((nivel) => nivel.conseguido)
    .map((nivel) => ({ emoji: nivel.emoji, texto: nivel.texto })),
)

const totalNiveles = logros.reduce(
  (suma, cadena) => suma + cadena.niveles.length,
  0,
)

const [logroNuevo, setLogroNuevo] = useState<{
  icono: string
  titulo: string
} | null>(null)

const logrosAnterioresRef = useRef<string[] | null>(null)

const [resumenAsignaturas, setResumenAsignaturas] = useState<
  { nombre: string; respuestas: number; porcentaje: number }[]
>([])

const [proximoContenido, setProximoContenido] = useState<{
  id: number
  nombre: string
  asignatura: string
  motivo: string
} | null>(null)

const [preguntaRapida, setPreguntaRapida] = useState('')

useEffect(() => {
  if (!logroNuevo) {
    return
  }

  const temporizador = setTimeout(() => setLogroNuevo(null), 4500)

  return () => clearTimeout(temporizador)
}, [logroNuevo])

  const [fotoPerfil, setFotoPerfil] =
    useState<string | null>(() => {
      return localStorage.getItem('fotoPerfil')
    })

  const [temasPendientes, setTemasPendientes] = useState<
  {
    id: number
    nombre: string
    asignatura: string
    asignaturaId: number
  }[]
>([])

  const [cargandoPendientes, setCargandoPendientes] = useState(false)

   useEffect(() => {
    if (!usuarioId) {
      return
    }

    cargarProgreso().finally(() => setCargandoDatos(false))
    cargarRecomendaciones()
  }, [usuarioId])

  function obtenerNivel() {
    return Math.floor(xp / 200) + 1
  }

  function obtenerXpNivelActual() {
    return xp % 200
  }

  function cambiarFotoPerfil(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const archivo = event.target.files?.[0]

    if (!archivo) {
      return
    }

    if (!archivo.type.startsWith('image/')) {
      window.alert('Selecciona una imagen válida.')
      return
    }

    const lector = new FileReader()

    lector.onload = () => {
      const resultado = lector.result

      if (typeof resultado !== 'string') {
        return
      }

      setFotoPerfil(resultado)

      localStorage.setItem(
        'fotoPerfil',
        resultado,
      )
    }

    lector.readAsDataURL(archivo)
  }

    // Trae TODAS las filas de una tabla, de 1000 en 1000
  async function traerTodasLasFilas(
    tabla: string,
    columnas: string,
  ): Promise<any[]> {
    const filas: any[] = []
    const tamano = 1000
    let desde = 0

    while (true) {
      const { data, error } = await supabase
        .from(tabla)
        .select(columnas)
        .order('id', { ascending: true })
        .range(desde, desde + tamano - 1)

      if (error) {
        console.error(`Error cargando ${tabla}:`, error)
        break
      }

      const lote = (data ?? []) as unknown as any[]
      filas.push(...lote)

      if (lote.length < tamano) {
        break
      }

      desde += tamano
    }

    return filas
  }

  function normalizarTexto(texto: string) {
    return texto
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  // Dice si un enunciado se parece demasiado a alguno que ya existe
  function esRepetido(enunciado: string, existentes: string[]) {
    const nuevo = normalizarTexto(enunciado)

    const palabrasNuevo = new Set(
      nuevo.split(' ').filter((palabra) => palabra.length > 3),
    )

    return existentes.some((existente) => {
      const normal = normalizarTexto(existente)

      if (normal === nuevo) {
        return true
      }

      const palabras = normal
        .split(' ')
        .filter((palabra) => palabra.length > 3)

      if (palabras.length === 0 || palabrasNuevo.size === 0) {
        return false
      }

      const comunes = palabras.filter((palabra) =>
        palabrasNuevo.has(palabra),
      ).length

      const similitud =
        comunes / Math.max(palabras.length, palabrasNuevo.size)

      return similitud >= 0.7
    })
  }

  // Enunciados de todos los ejercicios del tema (principal + adicionales)
  // y de los ya respondidos
  async function obtenerEnunciadosDelTema(
    temaId: number | null,
  ): Promise<string[]> {
    if (!temaId) {
      return []
    }

    const { data: pendientes } = await supabase
      .from('ejercicios')
      .select('enunciado')
      .eq('tema_id', temaId)

    const { data: respondidos } = await supabase
      .from('respuestas_ejercicios')
      .select('enunciado_ejercicio')
      .eq('tema_id', temaId)

    return [
      ...(pendientes ?? []).map((ejercicio) => ejercicio.enunciado),
      ...(respondidos ?? []).map(
        (respuesta) => respuesta.enunciado_ejercicio,
      ),
    ].filter(Boolean)
  }

    // ----- Complementos de la foto de perfil -----
  async function alternarComplemento(emoji: string) {
    let nuevos: string[]

    if (complementos.includes(emoji)) {
      nuevos = complementos.filter((actual) => actual !== emoji)
    } else if (complementos.length >= 3) {
      window.alert('Pots portar com a màxim 3 complements. Treu-ne un abans.')
      return
    } else {
      nuevos = [...complementos, emoji]
    }

    const { error } = await supabase.auth.updateUser({
      data: { complementos: nuevos },
    })

    if (error) {
      console.error('Error guardando el complemento:', error)

      window.alert("No s'ha pogut guardar el complement.")
    }
  }

    // ----- Sesión -----
  async function iniciarSesion(event: React.FormEvent) {
    event.preventDefault()

    setIniciandoSesion(true)
    setErrorLogin('')

    const { error } = await supabase.auth.signInWithPassword({
      email: emailLogin.trim(),
      password: passwordLogin,
    })

    if (error) {
      setErrorLogin('Correu o contrasenya incorrectes.')
    } else {
      setPasswordLogin('')
    }

    setIniciandoSesion(false)
  }

  async function cerrarSesion() {
    await supabase.auth.signOut()
  }

    // ----- Historial del chat -----
  async function cargarHistorialChat() {
    const { data, error } = await supabase
      .from('chat_mensajes')
      .select('rol, texto')
      .order('id', { ascending: false })
      .limit(60)

    if (error) {
      console.error('Error cargando el historial del chat:', error)
      return
    }

    setMensajesChat(
      (data ?? []).reverse().map((fila) => ({
        rol: fila.rol === 'ia' ? ('ia' as const) : ('usuario' as const),
        texto: String(fila.texto ?? ''),
      })),
    )
  }

  async function limpiarHistorialChat() {
    const confirmar = window.confirm(
      'Segur que vols esborrar tota la conversa?',
    )

    if (!confirmar) {
      return
    }

    const { error } = await supabase
      .from('chat_mensajes')
      .delete()
      .gte('id', 0)

    if (error) {
      console.error('Error borrando el chat:', error)
      window.alert('No se ha podido borrar la conversa.')
      return
    }

    setMensajesChat([])
  }

  // Texto de todos los PDFs de un tema
  async function obtenerTextoCompletoDelTema(temaId: number): Promise<string> {
    const { data: materialesTema } = await supabase
      .from('materiales')
      .select('nombre_archivo, ruta_archivo')
      .eq('tema_id', temaId)
      .order('id', { ascending: true })

    const textos: string[] = []

    for (const material of materialesTema ?? []) {
            const archivo = await descargarPdf(
        material.ruta_archivo,
        material.nombre_archivo,
      )

      textos.push(await extraerTextoPdf(archivo))
    }

    return textos.join('\n\n')
  }

  // ----- Flashcards -----
  async function contarTarjetas(temaId: number | null) {
    const hoy = fechaEnDias(0)

    let consultaTotal = supabase
      .from('flashcards')
      .select('id', { count: 'exact', head: true })

    let consultaHoy = supabase
      .from('flashcards')
      .select('id', { count: 'exact', head: true })
      .lte('proxima_revision', hoy)

    if (temaId) {
      consultaTotal = consultaTotal.eq('tema_id', temaId)
      consultaHoy = consultaHoy.eq('tema_id', temaId)
    }

    const { count: total } = await consultaTotal
    const { count: pendientes } = await consultaHoy

    setEstadoTarjetas({ total: total ?? 0, hoy: pendientes ?? 0 })
  }

  async function generarTarjetas() {
    if (!temaFlashId) {
      return
    }

    setGenerandoTarjetas(true)

    try {
      const texto = await obtenerTextoCompletoDelTema(temaFlashId)

      if (!texto.trim()) {
        window.alert('Este tema no tiene texto en sus PDFs.')
        return
      }

      const { data: existentes } = await supabase
        .from('flashcards')
        .select('pregunta')
        .eq('tema_id', temaFlashId)

      const preguntasExistentes = (existentes ?? []).map(
        (fila) => fila.pregunta as string,
      )

      const respuesta = await fetch(
        API_IA + '/generar-flashcards',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            texto,
            cantidad: 8,
            existentes: preguntasExistentes,
          }),
        },
      )

      if (!respuesta.ok) {
        throw new Error('No se han podido generar las flashcards.')
      }

      const datos = await respuesta.json()

      const nuevas: { pregunta: string; respuesta: string }[] = []

      for (const tarjeta of datos.flashcards ?? []) {
        if (!tarjeta?.pregunta || !tarjeta?.respuesta) {
          continue
        }

        const yaExistentes = [
          ...preguntasExistentes,
          ...nuevas.map((nueva) => nueva.pregunta),
        ]

        if (esRepetido(String(tarjeta.pregunta), yaExistentes)) {
          continue
        }

        nuevas.push({
          pregunta: String(tarjeta.pregunta),
          respuesta: String(tarjeta.respuesta),
        })
      }

      if (nuevas.length === 0) {
        window.alert('La IA no ha generat targetes noves. Torna-ho a provar.')
        return
      }

      const { data: temaDatos } = await supabase
        .from('temas')
        .select('asignatura_id')
        .eq('id', temaFlashId)
        .single()

      const { error } = await supabase.from('flashcards').insert(
        nuevas.map((nueva) => ({
          tema_id: temaFlashId,
          asignatura_id: temaDatos?.asignatura_id ?? null,
          pregunta: nueva.pregunta,
          respuesta: nueva.respuesta,
        })),
      )

      if (error) {
        throw error
      }

      await contarTarjetas(temaFlashId)

      window.alert(`${nuevas.length} targetes noves creades.`)
    } catch (error) {
      console.error('Error generando flashcards:', error)

      window.alert('No se han podido generar las flashcards.')
    } finally {
      setGenerandoTarjetas(false)
    }
  }

  async function comenzarRepasoTarjetas() {
    let consulta = supabase
      .from('flashcards')
      .select('id, tema_id, pregunta, respuesta, caja')
      .lte('proxima_revision', fechaEnDias(0))

    if (temaFlashId) {
      consulta = consulta.eq('tema_id', temaFlashId)
    }

    const { data, error } = await consulta
      .order('caja', { ascending: true })
      .limit(30)

    if (error) {
      console.error('Error cargando flashcards:', error)
      window.alert('No se han podido cargar las targetes.')
      return
    }

    const cola = (data ?? []) as unknown as Tarjeta[]

    if (cola.length === 0) {
      window.alert('No tens targetes per repassar ara mateix.')
      return
    }

    setColaTarjetas(cola)
    setTotalSesionTarjetas(cola.length)
    setTarjetasSabidas(0)
    setRespuestaVisible(false)
    setSesionTarjetasActiva(true)
  }

  async function valorarTarjeta(sabe: boolean) {
    const actual = colaTarjetas[0]

    if (!actual) {
      return
    }

    const nuevaCaja = sabe ? Math.min(actual.caja + 1, 5) : 1

    const proxima = sabe
      ? fechaEnDias(INTERVALOS_CAJA[nuevaCaja])
      : fechaEnDias(0)

    const { error } = await supabase
      .from('flashcards')
      .update({ caja: nuevaCaja, proxima_revision: proxima })
      .eq('id', actual.id)

    if (error) {
      console.error('Error guardando la targeta:', error)
      window.alert('No se ha podido guardar el resultado.')
      return
    }

    setRespuestaVisible(false)

    if (sabe) {
      setTarjetasSabidas((valor) => valor + 1)
    }

    // Si no la sabe, vuelve al final de la cola para repetirla en esta sesión
    setColaTarjetas((cola) => {
      const resto = cola.slice(1)
      return sabe ? resto : [...resto, { ...actual, caja: 1 }]
    })
  }

  // ----- Examen -----
  async function empezarExamen() {
    setPreparandoExamen(true)

    try {
      let consulta = supabase
        .from('ejercicios')
        .select('id, titulo, enunciado, solucion, dificultad, tema_id')

      if (temaExamenId) {
        consulta = consulta.eq('tema_id', temaExamenId)
      }

      const { data, error } = await consulta

      if (error) {
        throw error
      }

      const todas = (data ?? []) as unknown as PreguntaExamen[]

      if (todas.length === 0) {
        window.alert('No hi ha exercicis per fer un examen amb aquesta selecció.')
        return
      }

      const preguntas = [...todas]
        .sort(() => Math.random() - 0.5)
        .slice(0, numPreguntasExamen)

      setExamen({
        preguntas,
        indice: 0,
        respuestas: preguntas.map(() => ''),
                fase: 'respondiendo',
        modo: modoExamen,
        inicioMs: Date.now(),
        finMs: modoExamen === 'simulacro' ? Date.now() + 3600000 : null,
        progreso: 0,
        resultados: [],
        recomendacion: '',
      })
    } catch (error) {
      console.error('Error preparando el examen:', error)

      window.alert('No se ha podido preparar el examen.')
    } finally {
      setPreparandoExamen(false)
    }
  }

  async function finalizarExamen() {
    if (!examen) {
      return
    }

    const preguntas = examen.preguntas
    const respuestas = examen.respuestas

    setExamen({ ...examen, fase: 'corrigiendo', progreso: 0 })

    const resultados: ResultadoExamen[] = []

    for (let i = 0; i < preguntas.length; i++) {
      const respuestaAlumno = respuestas[i].trim()

      if (!respuestaAlumno) {
        resultados.push({
          correcta: false,
          comentario: 'No has respost aquesta pregunta.',
        })
      } else {
        try {
          const respuestaIA = await fetch(API_IA + '/corregir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              enunciado: preguntas[i].enunciado,
              solucion: preguntas[i].solucion,
              respuesta: respuestaAlumno,
              dificultad: preguntas[i].dificultad,
              xp: 0,
            }),
          })

          if (!respuestaIA.ok) {
            throw new Error('No se ha podido corregir.')
          }

          const correccion = await respuestaIA.json()

          resultados.push({
            correcta: !!correccion.correcta,
            comentario: String(correccion.comentario ?? ''),
          })
        } catch (error) {
          console.error('Error corrigiendo una pregunta del examen:', error)

          resultados.push({
            correcta: false,
            comentario: "No s'ha pogut corregir aquesta resposta.",
          })
        }
      }

      setExamen((actual) =>
        actual ? { ...actual, progreso: i + 1 } : actual,
      )
    }

    // Recomendación de la IA según los fallos
    let recomendacion = ''

    try {
      const porTema: Record<
        string,
        {
          nombre: string
          asignatura: string
          errores: number
          aciertos: number
          ejerciciosFallados: string[]
        }
      > = {}

      preguntas.forEach((pregunta, i) => {
        const temaDeLaPregunta = progresoTemas.find(
          (tema) => tema.id === pregunta.tema_id,
        )

        const clave = String(pregunta.tema_id ?? 'sin-tema')

        if (!porTema[clave]) {
          porTema[clave] = {
            nombre: temaDeLaPregunta?.nombre ?? 'Tema',
            asignatura: temaDeLaPregunta?.asignatura ?? '',
            errores: 0,
            aciertos: 0,
            ejerciciosFallados: [],
          }
        }

        if (resultados[i].correcta) {
          porTema[clave].aciertos++
        } else {
          porTema[clave].errores++
          porTema[clave].ejerciciosFallados.push(pregunta.enunciado)
        }
      })

      const respuestaRecomendacion = await fetch(
        API_IA + '/generar-recomendacion',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recomendaciones: Object.values(porTema),
          }),
        },
      )

      if (respuestaRecomendacion.ok) {
        const datos = await respuestaRecomendacion.json()
        recomendacion = String(datos.recomendacion ?? '').trim()
      }
    } catch (error) {
      console.error('Error generando la recomendación del examen:', error)
    }

        // Guardar la nota en el historial
    const aciertosFinales = resultados.filter(
      (resultado) => resultado.correcta,
    ).length

    const { error: errorHistorial } = await supabase
      .from('examenes_historial')
      .insert({
        tema_id: temaExamenId,
        modo: examen.modo,
        total: preguntas.length,
        aciertos: aciertosFinales,
        segundos: Math.round((Date.now() - examen.inicioMs) / 1000),
      })

    if (errorHistorial) {
      console.error('Error guardando el historial del examen:', errorHistorial)
    } else {
      cargarHistorialExamenes()
    }

    setExamen((actual) =>
      actual
        ? { ...actual, fase: 'resultado', resultados, recomendacion }
        : actual,
    )
  }

    // Al elegir un tema en el chat: descarga sus PDFs y guarda el texto
  async function seleccionarTemaChat(valor: string) {
    if (!valor) {
      setTemaChatId(null)
      setContextoChat('')
      return
    }

    const temaId = Number(valor)

    setTemaChatId(temaId)
    setContextoChat('')
    setCargandoContextoChat(true)

    try {
      const { data: materialesTema } = await supabase
        .from('materiales')
        .select('nombre_archivo, ruta_archivo')
        .eq('tema_id', temaId)
        .order('id', { ascending: true })

      const textos: string[] = []

      for (const material of materialesTema ?? []) {
        const { data: urlPdf } = supabase.storage
          .from('Materiales')
          .getPublicUrl(material.ruta_archivo)

        const respuestaPdf = await fetch(urlPdf.publicUrl)
        const blob = await respuestaPdf.blob()

        const archivo = new File([blob], material.nombre_archivo, {
          type: 'application/pdf',
        })

        textos.push(await extraerTextoPdf(archivo))
      }

      setContextoChat(textos.join('\n\n'))
    } catch (error) {
      console.error('Error cargando el material para el chat:', error)

      window.alert('No se ha podido cargar el material de este tema.')

      setTemaChatId(null)
    } finally {
      setCargandoContextoChat(false)
    }
  }

  // Envía un mensaje al chat (escrito por ti o desde un atajo)
  async function enviarMensajeChat(textoManual?: string, general = false) {
    const pregunta = (textoManual ?? textoChat).trim()

    if (!pregunta || escribiendoChat) {
      return
    }

    const historial: { rol: 'usuario' | 'ia'; texto: string }[] = [
      ...mensajesChat,
      { rol: 'usuario', texto: pregunta },
    ]

    setMensajesChat(historial)
    setTextoChat('')
    setEscribiendoChat(true)

    try {
      const temaElegido = progresoTemas.find(
        (tema) => tema.id === temaChatId,
      )

      const perfil = [
        `Nivel ${obtenerNivel()} con ${xp} XP.`,
        problemasRecurrentes.length > 0
          ? `Temas donde falla más: ${problemasRecurrentes
              .map((tema) => `${tema.nombre} (${tema.asignatura})`)
              .join(', ')}.`
          : '',
        erroresRepaso.length > 0
          ? `Ejercicios que ha fallado y aún no ha superado: ${erroresRepaso
              .slice(0, 3)
              .map((item) => item.enunciado)
              .join(' | ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')

      const respuesta = await fetch(API_IA + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mensajes: historial.slice(-8),
          contexto: contextoChat,
          nombreTema: temaElegido?.nombre ?? '',
          perfil,
          general,
        }),
      })

      if (!respuesta.ok) {
        throw new Error('El servidor no ha podido responder.')
      }

      const datos = await respuesta.json()

            const textoRespuesta = String(datos.respuesta ?? '')

      setMensajesChat([
        ...historial,
        { rol: 'ia', texto: textoRespuesta },
      ])

      const { error: errorGuardado } = await supabase
        .from('chat_mensajes')
        .insert([
          { rol: 'usuario', texto: pregunta, tema_id: temaChatId },
          { rol: 'ia', texto: textoRespuesta, tema_id: temaChatId },
        ])

      if (errorGuardado) {
        console.error('Error guardando el chat:', errorGuardado)
      }
    } catch (error) {
      console.error('Error en el chat:', error)

      setMensajesChat([
        ...historial,
        {
          rol: 'ia',
          texto:
            'No he pogut respondre ara mateix. Comprova que el servidor i Ollama estan encesos.',
        },
      ])
    } finally {
      setEscribiendoChat(false)
    }
  }

    // Descarga el PDF del tema (el indicado o, si no, el principal) y devuelve su texto
  async function obtenerTextoPdfDelTema(
    temaId: number,
    materialIdPreferido: number | null,
  ): Promise<{ materialId: number; textoPdf: string } | null> {
    const { data: materialesTema } = await supabase
      .from('materiales')
      .select('id, nombre_archivo, ruta_archivo, tipo')
      .eq('tema_id', temaId)
      .order('id', { ascending: true })

    const lista = materialesTema ?? []

    const material =
      lista.find((item) => item.id === materialIdPreferido) ??
      lista.find((item) => item.tipo === 'principal') ??
      lista[0]

    if (!material) {
      return null
    }

    const { data: urlPdf } = supabase.storage
      .from('Materiales')
      .getPublicUrl(material.ruta_archivo)

    const respuestaPdf = await fetch(urlPdf.publicUrl)
    const blob = await respuestaPdf.blob()

    const archivo = new File([blob], material.nombre_archivo, {
      type: 'application/pdf',
    })

    return {
      materialId: material.id,
      textoPdf: await extraerTextoPdf(archivo),
    }
  }

  // Botón "Repassar": la IA explica el concepto del ejercicio fallado
  async function repasarError(item: (typeof erroresRepaso)[number]) {
    setRepasoActivo({
      clave: item.clave,
      cargando: true,
      explicacion: '',
    })

    try {
      const pdf = await obtenerTextoPdfDelTema(item.temaId, item.materialId)

      if (!pdf) {
        window.alert('Este tema no tiene ningún PDF para explicar el concepto.')
        setRepasoActivo(null)
        return
      }

      const respuesta = await fetch(
        API_IA + '/explicar-concepto',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            texto: pdf.textoPdf,
            enunciado: item.enunciado,
          }),
        },
      )

      if (!respuesta.ok) {
        throw new Error('No se ha podido generar la explicación.')
      }

      const datos = await respuesta.json()

      setRepasoActivo({
        clave: item.clave,
        cargando: false,
        explicacion: datos.explicacion ?? '',
      })
    } catch (errorRepaso) {
      console.error('Error explicando el concepto:', errorRepaso)

      window.alert('No se ha podido generar la explicación.')

      setRepasoActivo(null)
    }
  }

  // Botón "Practicar-ho": genera 2 ejercicios de refuerzo sobre ese error
  async function practicarError(item: (typeof erroresRepaso)[number]) {
    setGenerandoPractica(item.clave)

    try {
      const pdf = await obtenerTextoPdfDelTema(item.temaId, item.materialId)

      if (!pdf) {
        window.alert('Este tema no tiene ningún PDF para generar ejercicios.')
        return
      }

      const nuevos = await generarEjerciciosRefuerzo(
        pdf.textoPdf,
        item.temaId,
        [item.enunciado],
        2,
      )

      const { data: temaDatos } = await supabase
        .from('temas')
        .select('asignatura_id')
        .eq('id', item.temaId)
        .single()

      const { error: errorInsert } = await supabase
        .from('ejercicios')
        .insert(
          nuevos.map((ejercicio) => {
            const dificultad = ['facil', 'media', 'dificil'].includes(
              ejercicio.dificultad,
            )
              ? ejercicio.dificultad
              : 'facil'

            return {
              tema_id: item.temaId,
              asignatura_id: temaDatos?.asignatura_id ?? null,
              material_id: pdf.materialId,
              material_path: null,
              titulo: `Reforç · ${ejercicio.titulo}`,
              enunciado: ejercicio.enunciado,
              solucion: ejercicio.solucion,
              tipo: 'practica',
              dificultad,
              xp:
                dificultad === 'dificil'
                  ? 30
                  : dificultad === 'media'
                    ? 20
                    : 10,
            }
          }),
        )

      if (errorInsert) {
        throw errorInsert
      }

      await abrirTemaPendiente(item.temaId)
    } catch (errorPractica) {
      console.error('Error generando la práctica:', errorPractica)

            const mensaje = (errorPractica as { message?: string } | null)?.message

      window.alert(mensaje ?? 'No se han podido generar los ejercicios.')
    } finally {
      setGenerandoPractica(null)
    }
  }

  // Botón "Ja ho entenc": quita el error de la lista
    async function marcarErrorRepasado(item: (typeof erroresRepaso)[number]) {
    const { data, error } = await supabase
      .from('errores_repasados')
      .insert({ tema_id: item.temaId, enunciado: item.enunciado })
      .select('id')

    if (error) {
      console.error('Error marcando como repasado:', error)

      window.alert(`No se ha podido marcar como repasado: ${error.message}`)
      return
    }

    if (!data || data.length === 0) {
      window.alert('No se ha podido guardar el repaso.')
      return
    }

    setRepasoActivo(null)

    await cargarProgreso()
  }

    // Genera ejercicios de refuerzo: mismo concepto que los fallados, otro enunciado
    // Para el refuerzo solo se descarta un enunciado si es casi una copia (85% de palabras iguales)
  function esCopiaCasiExacta(enunciado: string, existentes: string[]) {
    const palabrasNuevo = normalizarTexto(enunciado)
      .split(' ')
      .filter((palabra) => palabra.length > 3)

    if (palabrasNuevo.length === 0) {
      return false
    }

    return existentes.some((existente) => {
      const palabras = normalizarTexto(existente)
        .split(' ')
        .filter((palabra) => palabra.length > 3)

      if (palabras.length === 0) {
        return false
      }

      const conjunto = new Set(palabras)

      const comunes = palabrasNuevo.filter((palabra) =>
        conjunto.has(palabra),
      ).length

      return comunes / Math.max(palabras.length, palabrasNuevo.length) >= 0.85
    })
  }

  // Genera ejercicios de refuerzo: mismo concepto que los fallados, otro enunciado
  async function generarEjerciciosRefuerzo(
    textoPdf: string,
    temaId: number,
    ejerciciosFallados: string[],
    cantidad: number,
  ): Promise<any[]> {
    const enunciados = await obtenerEnunciadosDelTema(temaId)
    const resultado: any[] = []
    let fallos = 0
    let ultimoMotivo = 'sin respuesta'

    while (resultado.length < cantidad && fallos < 10) {
      const respuesta = await fetch(
        API_IA + '/generar-ejercicio-refuerzo',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            texto: textoPdf,
            ejerciciosFallados,
            ejerciciosAnteriores: enunciados,
          }),
        },
      )

      if (!respuesta.ok) {
        fallos++
        ultimoMotivo = `el servidor respondió ${respuesta.status}`
        console.warn('Refuerzo descartado:', ultimoMotivo)
        continue
      }

      const generado = await respuesta.json()
      const nuevo = generado.ejercicio

      if (!nuevo?.enunciado || !nuevo?.solucion) {
        fallos++
        ultimoMotivo = 'la IA devolvió un ejercicio incompleto'
        console.warn('Refuerzo descartado:', ultimoMotivo)
        continue
      }

      if (esCopiaCasiExacta(nuevo.enunciado, enunciados)) {
        fallos++
        ultimoMotivo = 'la IA repetía un ejercicio que ya tienes'
        console.warn('Refuerzo descartado:', ultimoMotivo)
        continue
      }

      resultado.push(nuevo)
      enunciados.push(nuevo.enunciado)
    }

    if (resultado.length === 0) {
      throw new Error(
        `No se han podido generar ejercicios de refuerzo (${ultimoMotivo}).`,
      )
    }

    return resultado
  }

  // Botón "Practicar aquest tema": genera 3 ejercicios de refuerzo y abre el tema
  async function practicarTemaDebil(temaId: number) {
    setGenerandoRefuerzo(temaId)

    try {
      // 1. Ejercicios que has fallado en este tema
      const { data: fallos, error: errorFallos } = await supabase
        .from('respuestas_ejercicios')
        .select('enunciado_ejercicio, material_id')
        .eq('tema_id', temaId)
        .eq('correcta', false)
        .order('id', { ascending: false })
        .limit(10)

      if (errorFallos) {
        throw errorFallos
      }

      const enunciadosFallados = Array.from(
        new Set(
          (fallos ?? [])
            .map((fallo) => fallo.enunciado_ejercicio)
            .filter(Boolean),
        ),
      ).slice(0, 5) as string[]

      if (enunciadosFallados.length === 0) {
        window.alert('No hay errores guardados de este tema para reforzar.')
        return
      }

      // 2. PDF de donde salieron esos ejercicios
      const { data: materialesTema } = await supabase
        .from('materiales')
        .select('id, nombre_archivo, ruta_archivo, tipo')
        .eq('tema_id', temaId)
        .order('id', { ascending: true })

      const listaMateriales = materialesTema ?? []

      const materialIdFallado = (fallos ?? []).find(
        (fallo) => fallo.material_id,
      )?.material_id

      const material =
        listaMateriales.find((item) => item.id === materialIdFallado) ??
        listaMateriales.find((item) => item.tipo === 'principal') ??
        listaMateriales[0]

      if (!material) {
        window.alert('Este tema no tiene ningún PDF para generar ejercicios.')
        return
      }

      const { data: urlPdf } = supabase.storage
        .from('Materiales')
        .getPublicUrl(material.ruta_archivo)

      const respuestaPdf = await fetch(urlPdf.publicUrl)
      const blob = await respuestaPdf.blob()

      const archivo = new File([blob], material.nombre_archivo, {
        type: 'application/pdf',
      })

      const textoPdf = await extraerTextoPdf(archivo)

      // 3. Generar 3 ejercicios de refuerzo
      const nuevos = await generarEjerciciosRefuerzo(
        textoPdf,
        temaId,
        enunciadosFallados,
        3,
      )

      const { data: temaDatos } = await supabase
        .from('temas')
        .select('asignatura_id')
        .eq('id', temaId)
        .single()

      // 4. Guardarlos
      const { error: errorInsert } = await supabase
        .from('ejercicios')
        .insert(
          nuevos.map((ejercicio) => {
            const dificultad = ['facil', 'media', 'dificil'].includes(
              ejercicio.dificultad,
            )
              ? ejercicio.dificultad
              : 'facil'

            return {
              tema_id: temaId,
              asignatura_id: temaDatos?.asignatura_id ?? null,
              material_id: material.id,
              material_path: null,
              titulo: `Reforç · ${ejercicio.titulo}`,
              enunciado: ejercicio.enunciado,
              solucion: ejercicio.solucion,
              tipo: 'practica',
              dificultad,
              xp:
                dificultad === 'dificil'
                  ? 30
                  : dificultad === 'media'
                    ? 20
                    : 10,
            }
          }),
        )

      if (errorInsert) {
        throw errorInsert
      }

      // 5. Abrir el tema para que los veas
      await abrirTemaPendiente(temaId)
    } catch (error) {
      console.error('Error generando ejercicios de refuerzo:', error)

      window.alert('No se han podido generar los ejercicios de refuerzo.')
    } finally {
      setGenerandoRefuerzo(null)
    }
  }

    // Nivel de dificultad según tus últimos resultados en el tema
  // (null = todavía hay pocos datos, se mantiene la mezcla normal)
  function dificultadSegunResultados(resultados: boolean[]): string | null {
    const total = resultados.length

    if (total < 3) {
      return null
    }

    const aciertos = resultados.filter(Boolean).length
    const tasa = aciertos / total

    if (tasa >= 0.8 && total >= 5) {
      return 'dificil'
    }

    if (tasa >= 0.6) {
      return 'media'
    }

    return 'facil'
  }

  async function obtenerDificultadObjetivo(
    temaId: number | null,
  ): Promise<string | null> {
    if (!temaId) {
      return null
    }

    const { data } = await supabase
      .from('respuestas_ejercicios')
      .select('correcta')
      .eq('tema_id', temaId)
      .order('id', { ascending: false })
      .limit(5)

    return dificultadSegunResultados(
      (data ?? []).map((respuesta) => respuesta.correcta),
    )
  }

  function xpPorDificultad(dificultad: string) {
    return dificultad === 'dificil' ? 30 : dificultad === 'media' ? 20 : 10
  }

  // Genera ejercicios que NO se repiten con ninguno del tema
  // y que se ajustan a tu nivel actual en ese tema
  async function generarEjerciciosSinRepetir(
    textoPdf: string,
    temaId: number | null,
    cantidad: number,
  ): Promise<any[]> {
    const enunciados = await obtenerEnunciadosDelTema(temaId)
    const dificultadObjetivo = await obtenerDificultadObjetivo(temaId)
    const resultado: any[] = []

    const ajustar = (ejercicio: any) => {
      if (dificultadObjetivo) {
        ejercicio.dificultad = dificultadObjetivo
        ejercicio.xp = xpPorDificultad(dificultadObjetivo)
      }

      return ejercicio
    }

    if (cantidad > 1) {
      const respuestaLote = await fetch(
        API_IA + '/generar-ejercicios',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            texto: textoPdf,
            ejerciciosAnteriores: enunciados,
            dificultad: dificultadObjetivo,
          }),
        },
      )

      if (!respuestaLote.ok) {
        throw new Error('No se han podido generar los ejercicios.')
      }

      const lote = await respuestaLote.json()

      for (const ejercicio of lote.ejercicios ?? []) {
        if (resultado.length >= cantidad) {
          break
        }

        if (
          !ejercicio?.enunciado ||
          esRepetido(ejercicio.enunciado, enunciados)
        ) {
          continue
        }

        resultado.push(ajustar(ejercicio))
        enunciados.push(ejercicio.enunciado)
      }
    }

    // Rellenar los que falten de uno en uno
    let fallos = 0

    while (resultado.length < cantidad && fallos < 6) {
      const respuestaUno = await fetch(
        API_IA + '/generar-un-ejercicio',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            texto: textoPdf,
            ejerciciosAnteriores: enunciados,
            dificultad: dificultadObjetivo,
          }),
        },
      )

      if (!respuestaUno.ok) {
        fallos++
        continue
      }

      const generado = await respuestaUno.json()
      const nuevo = generado.ejercicio

      if (!nuevo?.enunciado || esRepetido(nuevo.enunciado, enunciados)) {
        fallos++
        continue
      }

      resultado.push(ajustar(nuevo))
      enunciados.push(nuevo.enunciado)
    }

    if (resultado.length === 0) {
      throw new Error(
        'No se ha podido generar un ejercicio nuevo que no se repita.',
      )
    }

    return resultado
  }

    async function cargarProgreso() {
        const respuestas = await traerTodasLasFilas(
      'respuestas_ejercicios',
      'ejercicio_id, correcta, xp_ganada, asignatura_id, tema_id, created_at, enunciado_ejercicio, material_id, repasada',
    )

    const listaAsignaturas = await traerTodasLasFilas(
      'asignaturas',
      'id, nombre',
    )

    const listaTemas = await traerTodasLasFilas(
      'temas',
      'id, nombre, asignatura_id',
    )

    const listaEjercicios = await traerTodasLasFilas(
      'ejercicios',
      'id, tema_id',
    )

    // ----- XP y contadores -----
    const totalRespuestas = respuestas.length

    const totalCorrectas = respuestas.filter(
      (respuesta) => respuesta.correcta,
    ).length

        const sesionesPomodoro = await traerTodasLasFilas(
      'pomodoros',
      'minutos, xp, created_at',
    )

    const xpTotal =
      respuestas.reduce(
        (suma, respuesta) => suma + (respuesta.xp_ganada ?? 0),
        0,
      ) +
      sesionesPomodoro.reduce((suma, pomodoro) => suma + (pomodoro.xp ?? 0), 0)

    const hoyPomodoro = new Date().toLocaleDateString('sv-SE')

    setResumenPomodoro({
      hoy: sesionesPomodoro.filter(
        (pomodoro) =>
          new Date(pomodoro.created_at).toLocaleDateString('sv-SE') ===
          hoyPomodoro,
      ).length,
      total: sesionesPomodoro.length,
    })

    setXp(xpTotal)

    
    const nivelNuevo = Math.floor(xpTotal / 200) + 1

    if (
      nivelAnteriorRef.current !== null &&
      nivelNuevo > nivelAnteriorRef.current
    ) {
      setNivelSubido(nivelNuevo)
    }

    nivelAnteriorRef.current = nivelNuevo

    setEjerciciosCompletados(totalRespuestas)
    setEjerciciosCorrectos(totalCorrectas)
    setEjerciciosIncorrectos(totalRespuestas - totalCorrectas)

    // ----- Progreso por asignatura -----
    const idsRespondidos = new Set(
      respuestas.map((respuesta) => respuesta.ejercicio_id),
    )

    setProgresoAsignaturas(
      listaAsignaturas.map((asignatura) => {
        const idsTemasAsignatura = listaTemas
          .filter((tema) => tema.asignatura_id === asignatura.id)
          .map((tema) => tema.id)

        const ejerciciosAsignatura = listaEjercicios.filter(
          (ejercicio) => idsTemasAsignatura.includes(ejercicio.tema_id),
        )

        return {
          nombre: asignatura.nombre,
          total: ejerciciosAsignatura.length,
          completados: ejerciciosAsignatura.filter((ejercicio) =>
            idsRespondidos.has(ejercicio.id),
          ).length,
        }
      }),
    )

    // ----- Progreso por tema -----
    setProgresoTemas(
      listaTemas.map((tema) => {
        const respuestasTema = respuestas.filter(
          (respuesta) => respuesta.tema_id === tema.id,
        )

        const correctasTema = respuestasTema.filter(
          (respuesta) => respuesta.correcta,
        ).length

        return {
          id: tema.id,
          nombre: tema.nombre,
          asignatura:
            listaAsignaturas.find(
              (asignatura) => asignatura.id === tema.asignatura_id,
            )?.nombre ?? 'Asignatura',
          correctas: correctasTema,
          incorrectas: respuestasTema.length - correctasTema,
                    dificultad: dificultadSegunResultados(
            respuestasTema
              .slice(-5)
              .map((respuesta) => respuesta.correcta),
          ),
        }
      }),
    )

        // ----- Problemas recurrentes (3 o más fallos en las últimas 5 respuestas del tema) -----
    const recurrentes = listaTemas
      .map((tema) => {
        const ultimas = respuestas
          .filter((respuesta) => respuesta.tema_id === tema.id)
          .slice(-5)

        const fallos = ultimas.filter(
          (respuesta) => !respuesta.correcta,
        ).length

        return {
          id: tema.id,
          nombre: tema.nombre,
          asignatura:
            listaAsignaturas.find(
              (asignatura) => asignatura.id === tema.asignatura_id,
            )?.nombre ?? 'Asignatura',
          fallos,
          total: ultimas.length,
        }
      })
      .filter((tema) => tema.fallos >= 3)
      .sort((a, b) => b.fallos - a.fallos)

    setProblemasRecurrentes(recurrentes)

        // ----- Errores pendientes de repasar -----
    const grupos: Record<string, any[]> = {}

    respuestas.forEach((respuesta) => {
      if (!respuesta.enunciado_ejercicio || !respuesta.tema_id) {
        return
      }

      const clave = `${respuesta.tema_id}|${respuesta.enunciado_ejercicio}`

      if (!grupos[clave]) {
        grupos[clave] = []
      }

      grupos[clave].push(respuesta)
    })

        const repasados = await traerTodasLasFilas(
      'errores_repasados',
      'tema_id, enunciado',
    )

    const clavesRepasadas = new Set(
      repasados.map((fila) => `${fila.tema_id}|${fila.enunciado}`),
    )

    const pendientesRepaso = Object.entries(grupos)
      .filter(([clave, lista]) => {
        const ultima = lista[lista.length - 1]
        return !ultima.correcta && !clavesRepasadas.has(clave)
      })

      .map(([clave, lista]) => {
        const ultima = lista[lista.length - 1]

        const temaDelError = listaTemas.find(
          (tema) => tema.id === ultima.tema_id,
        )

        return {
          clave,
          enunciado: ultima.enunciado_ejercicio as string,
          temaId: ultima.tema_id as number,
          temaNombre: temaDelError?.nombre ?? 'Tema',
          asignatura:
            listaAsignaturas.find(
              (asignatura) => asignatura.id === temaDelError?.asignatura_id,
            )?.nombre ?? 'Asignatura',
          materialId: (ultima.material_id ?? null) as number | null,
          fallos: lista.filter((respuesta) => !respuesta.correcta).length,
        }
      })
      .sort((a, b) => b.fallos - a.fallos)

    setErroresRepaso(pendientesRepaso)

          // ----- Objetivo diario, racha y logros -----
    const hoyTexto = new Date().toLocaleDateString('sv-SE')

    const respuestasConFecha = respuestas.filter(
      (respuesta) => respuesta.created_at,
    )

    const respuestasHoy = respuestasConFecha.filter(
      (respuesta) =>
        new Date(respuesta.created_at).toLocaleDateString('sv-SE') ===
        hoyTexto,
    )

    setObjetivoHoy({
      ejercicios: respuestasHoy.length,
      xp: respuestasHoy.reduce(
        (suma, respuesta) => suma + (respuesta.xp_ganada ?? 0),
        0,
      ),
    })

    const diasConActividad = new Set(
      respuestasConFecha.map((respuesta) =>
        new Date(respuesta.created_at).toLocaleDateString('sv-SE'),
      ),
    )

    // Racha: días seguidos (si hoy aún no has estudiado, cuenta desde ayer)
    let racha = 0
    const cursorDia = new Date()

    if (!diasConActividad.has(cursorDia.toLocaleDateString('sv-SE'))) {
      cursorDia.setDate(cursorDia.getDate() - 1)
    }

    while (diasConActividad.has(cursorDia.toLocaleDateString('sv-SE'))) {
      racha++
      cursorDia.setDate(cursorDia.getDate() - 1)
    }

    setRachaDias(racha)

    // Mejor serie de respuestas correctas seguidas
    let mejorSerie = 0
    let serieActual = 0

    respuestas.forEach((respuesta) => {
      if (respuesta.correcta) {
        serieActual++
        mejorSerie = Math.max(mejorSerie, serieActual)
      } else {
        serieActual = 0
      }
    })

       // ----- Logros: cadenas de retos cada vez más difíciles -----
    const temasDominados = listaTemas.filter(
      (tema) =>
        dificultadSegunResultados(
          respuestas
            .filter((respuesta) => respuesta.tema_id === tema.id)
            .slice(-5)
            .map((respuesta) => respuesta.correcta),
        ) === 'dificil',
    ).length

    const estadoAsignaturas = listaAsignaturas.map((asignatura) => {
      const deLaAsignatura = respuestas.filter(
        (respuesta) => respuesta.asignatura_id === asignatura.id,
      )

      const aciertosAsignatura = deLaAsignatura.filter(
        (respuesta) => respuesta.correcta,
      ).length

      return {
        total: deLaAsignatura.length,
        porcentaje:
          deLaAsignatura.length === 0
            ? 0
            : (aciertosAsignatura / deLaAsignatura.length) * 100,
      }
    })

    // Mejor racha de días seguidos de toda la historia
    const diasOrdenados = Array.from(diasConActividad).sort()
    let mejorRachaDias = 0
    let rachaTemporal = 0
    let diaAnterior: Date | null = null

    for (const dia of diasOrdenados) {
      const fechaDia = new Date(`${dia}T00:00:00`)

      if (
        diaAnterior &&
        Math.round(
          (fechaDia.getTime() - diaAnterior.getTime()) / 86400000,
        ) === 1
      ) {
        rachaTemporal++
      } else {
        rachaTemporal = 1
      }

      mejorRachaDias = Math.max(mejorRachaDias, rachaTemporal)
      diaAnterior = fechaDia
    }

    const { count: totalTarjetasDominadas } = await supabase
      .from('flashcards')
      .select('id', { count: 'exact', head: true })
      .gte('caja', 4)

    const { count: totalPreguntasIA } = await supabase
      .from('chat_mensajes')
      .select('id', { count: 'exact', head: true })
      .eq('rol', 'usuario')

    const metricas: MetricasLogros = {
      correctas: totalCorrectas,
      respuestas: totalRespuestas,
      pctAcierto:
        totalRespuestas === 0
          ? 0
          : Math.round((totalCorrectas / totalRespuestas) * 100),
      xp: xpTotal,
      diasActivos: diasConActividad.size,
      mejorRachaDias,
      mejorSerie,
      temasDominados,
      asignaturasActivas: estadoAsignaturas.filter(
        (asignatura) => asignatura.total >= 5,
      ).length,
      asignaturasExcelentes: estadoAsignaturas.filter(
        (asignatura) => asignatura.total >= 20 && asignatura.porcentaje >= 80,
      ).length,
      erroresSuperados: repasados.length,
      tarjetasDominadas: totalTarjetasDominadas ?? 0,
      preguntasIA: totalPreguntasIA ?? 0,
    }

    // Los logros ya conseguidos se guardan en tu cuenta para que no se pierdan
    const { data: datosSesion } = await supabase.auth.getSession()
    const metadatos = datosSesion.session?.user.user_metadata ?? {}

    const guardados: string[] | undefined = Array.isArray(metadatos.logros)
      ? metadatos.logros
      : undefined

    const cadenasLogros = construirLogros(metricas, guardados ?? [])

    const idsConseguidos = cadenasLogros.flatMap((cadena) =>
      cadena.niveles
        .filter((nivel) => nivel.conseguido)
        .map((nivel) => nivel.id),
    )

    if (guardados === undefined) {
      // Primera vez: se guardan en silencio, sin avisos
      await supabase.auth.updateUser({ data: { logros: idsConseguidos } })
    } else {
      const nuevos = idsConseguidos.filter((id) => !guardados.includes(id))

      if (nuevos.length > 0) {
        const nivelNuevo = cadenasLogros
          .flatMap((cadena) => cadena.niveles)
          .find((nivel) => nivel.id === nuevos[nuevos.length - 1])

        if (nivelNuevo) {
          setLogroNuevo({ icono: nivelNuevo.emoji, titulo: nivelNuevo.texto })
        }

        await supabase.auth.updateUser({
          data: { logros: [...guardados, ...nuevos] },
        })
      }
    }

    logrosAnterioresRef.current = idsConseguidos

    setLogros(cadenasLogros)

        // ----- Resumen por asignatura y próximo contenido recomendado -----
    setResumenAsignaturas(
      listaAsignaturas.map((asignatura) => {
        const respuestasAsignatura = respuestas.filter(
          (respuesta) => respuesta.asignatura_id === asignatura.id,
        )

        const correctasAsignatura = respuestasAsignatura.filter(
          (respuesta) => respuesta.correcta,
        ).length

        return {
          nombre: asignatura.nombre,
          respuestas: respuestasAsignatura.length,
          porcentaje:
            respuestasAsignatura.length === 0
              ? 0
              : Math.round(
                  (correctasAsignatura / respuestasAsignatura.length) * 100,
                ),
        }
      }),
    )

    const candidatosTemas = listaTemas.map((tema) => {
      const respuestasTema = respuestas.filter(
        (respuesta) => respuesta.tema_id === tema.id,
      )

      const correctasDelTema = respuestasTema.filter(
        (respuesta) => respuesta.correcta,
      ).length

      return {
        id: tema.id,
        nombre: tema.nombre,
        asignatura:
          listaAsignaturas.find(
            (asignatura) => asignatura.id === tema.asignatura_id,
          )?.nombre ?? 'Asignatura',
        total: respuestasTema.length,
        acierto:
          respuestasTema.length === 0
            ? 1
            : correctasDelTema / respuestasTema.length,
      }
    })

    const temaSinEmpezar = candidatosTemas.find((tema) => tema.total === 0)

    const temaMasFlojo = candidatosTemas
      .filter((tema) => tema.total > 0)
      .sort((a, b) => a.acierto - b.acierto)[0]

    let proximo: {
      id: number
      nombre: string
      asignatura: string
      motivo: string
    } | null = null

    if (recurrentes.length > 0) {
      proximo = {
        id: recurrentes[0].id,
        nombre: recurrentes[0].nombre,
        asignatura: recurrentes[0].asignatura,
        motivo: 'Tens problemes recurrents aquí',
      }
    } else if (temaSinEmpezar) {
      proximo = {
        id: temaSinEmpezar.id,
        nombre: temaSinEmpezar.nombre,
        asignatura: temaSinEmpezar.asignatura,
        motivo: "Encara no l'has començat",
      }
    } else if (temaMasFlojo) {
      proximo = {
        id: temaMasFlojo.id,
        nombre: temaMasFlojo.nombre,
        asignatura: temaMasFlojo.asignatura,
        motivo: "És on tens menys encert",
      }
    }

    setProximoContenido(proximo)

    // ----- Estadísticas -----
    const ejerciciosDistintos = idsRespondidos.size

    const conteoAsignaturas = listaAsignaturas
      .map((asignatura) => ({
        nombre: asignatura.nombre,
        total: respuestas.filter(
          (respuesta) => respuesta.asignatura_id === asignatura.id,
        ).length,
      }))
      .sort((a, b) => b.total - a.total)

    setEstadisticas({
      porcentajeAcierto:
        totalRespuestas === 0
          ? 0
          : Math.round((totalCorrectas / totalRespuestas) * 100),
      xpTotal,
      xpMedia:
        ejerciciosDistintos === 0
          ? 0
          : Math.round(xpTotal / ejerciciosDistintos),
      intentosMedios:
        ejerciciosDistintos === 0
          ? 0
          : Math.round((totalRespuestas / ejerciciosDistintos) * 10) / 10,
      asignaturaMas:
        conteoAsignaturas.length > 0 && conteoAsignaturas[0].total > 0
          ? conteoAsignaturas[0].nombre
          : '—',
      asignaturaMenos:
        conteoAsignaturas.length > 1
          ? conteoAsignaturas[conteoAsignaturas.length - 1].nombre
          : '—',
    })

    // ----- Evolución de los últimos 14 días -----
    const dias: {
      clave: string
      dia: string
      correctas: number
      errores: number
    }[] = []

    for (let i = 13; i >= 0; i--) {
      const fecha = new Date()
      fecha.setDate(fecha.getDate() - i)

      dias.push({
        clave: fecha.toLocaleDateString('sv-SE'),
        dia: fecha.toLocaleDateString('ca-ES', {
          day: 'numeric',
          month: 'short',
        }),
        correctas: 0,
        errores: 0,
      })
    }

    respuestas.forEach((respuesta) => {
      if (!respuesta.created_at) {
        return
      }

      const clave = new Date(respuesta.created_at).toLocaleDateString(
        'sv-SE',
      )

      const diaEncontrado = dias.find((dia) => dia.clave === clave)

      if (!diaEncontrado) {
        return
      }

      if (respuesta.correcta) {
        diaEncontrado.correctas++
      } else {
        diaEncontrado.errores++
      }
    })

    setEvolucion(
      dias.map(({ dia, correctas, errores }) => ({
        dia,
        correctas,
        errores,
      })),
    )
  }

  async function cargarRecomendaciones() {
        const data = await traerTodasLasFilas(
      'respuestas_ejercicios',
      'tema_id, asignatura_id, material_id, material_path, correcta, enunciado_ejercicio',
    )

  const { data: temas, error: errorTemas } =
  await supabase
    .from('temas')
    .select('id, nombre')

if (errorTemas) {
  console.error(
    'ERROR CARGANDO NOMBRES DE TEMAS:',
    errorTemas,
  )
  return
}
const { data: asignaturas, error: errorAsignaturas } =
  await supabase
    .from('asignaturas')
    .select('id, nombre')

if (errorAsignaturas) {
  console.error(
    'ERROR CARGANDO ASIGNATURAS PARA RECOMENDACIONES:',
    errorAsignaturas,
  )
  return
}

  const erroresPorTema: Record<
  number,
  {
    nombre: string
    asignatura: string
    errores: number
    aciertos: number
    material: string
    ejerciciosFallados: string[]
  }
> = {}

  ;(data ?? []).forEach((respuesta) => {
   
    console.log(
  'ASIGNATURA ID DE RESPUESTA:',
  respuesta.asignatura_id,
)
   
    const temaId = respuesta.tema_id

    if (!temaId) return

    if (!erroresPorTema[temaId]) {
  erroresPorTema[temaId] = {
  nombre:
    temas?.find((tema) => tema.id === temaId)?.nombre
    ?? 'Tema desconocido',
  asignatura:
    asignaturas?.find(
      (asignatura) =>
        asignatura.id === respuesta.asignatura_id,
    )?.nombre
    ?? 'Asignatura desconocida',
  material: respuesta.material_path ?? 'Material desconocido',
  errores: 0,
  aciertos: 0,
  ejerciciosFallados: [],
}
}

    if (respuesta.correcta) {
      erroresPorTema[temaId].aciertos++
    } else {
  erroresPorTema[temaId].errores++

  if (respuesta.enunciado_ejercicio) {
    erroresPorTema[temaId].ejerciciosFallados.push(
      respuesta.enunciado_ejercicio,
    )
  }
}
  })

  const recomendacionesOrdenadas =
  Object.values(erroresPorTema)
    .sort((a, b) => b.errores - a.errores)

setRecomendaciones(recomendacionesOrdenadas)
const claveRecomendacion = recomendacionesOrdenadas
  .map((item) => `${item.nombre}:${item.errores}:${item.aciertos}`)
  .join('|')

try {
  const guardada = localStorage.getItem('recomendacionIA')

  if (guardada) {
    const { clave, texto } = JSON.parse(guardada)

    if (clave === claveRecomendacion && texto) {
      setRecomendacionIA(texto)
      return
    }
  }
} catch (errorCache) {
  console.error('Error leyendo la recomendación guardada:', errorCache)
}

try {
  console.log('LLAMANDO A GENERAR RECOMENDACIÓN')

  const respuestaIA = await fetch(
    API_IA + '/generar-recomendacion',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recomendaciones: recomendacionesOrdenadas,
      }),
    },
  )

  console.log(
    'RESPUESTA DEL SERVIDOR:',
    respuestaIA.status,
  )

  const datosIA =
    await respuestaIA.json()

  console.log(
    'RECOMENDACIÓN IA:',
    datosIA,
  )

    setRecomendacionIA(
    datosIA.recomendacion ?? '',
  )

  localStorage.setItem(
    'recomendacionIA',
    JSON.stringify({
      clave: claveRecomendacion,
      texto: datosIA.recomendacion ?? '',
    }),
  )

} catch (error) {
  console.error(
    'ERROR LLAMANDO A LA IA:',
    error,
  )
}

console.log(
  'RECOMENDACIONES POR TEMA:',
  recomendacionesOrdenadas,
)

console.log(
  'DATOS COMPLETOS PARA IA:',
  JSON.stringify(recomendacionesOrdenadas, null, 2),
)
}

    async function cargarEjercicios(
      temaId: number,
    ) {
      console.log(
        'Cargando ejercicios del tema:',
        temaId,
      )

      const { data, error } = await supabase
        .from('ejercicios')
        .select(
          'id, titulo, enunciado, tipo, dificultad, xp',
        )
        .eq('tema_id', temaId)
        .is('material_path', null)
        .order('id', {
          ascending: true,
        })

      if (error) {
        console.error(
          'Error cargando ejercicios:',
          error,
        )

        return
      }

      setEjercicios(data ?? [])
    }

    async function cargarEjerciciosPdf(materialId: number) {
  const { data, error } = await supabase
    .from('ejercicios')
    .select(
      'id, titulo, enunciado, tipo, dificultad, xp',
    )
    .eq('material_id', materialId)
    .order('id', {
      ascending: true,
    })

  if (error) {
    console.error(
      'Error cargando ejercicios del PDF:',
      error,
    )

    return
  }

  console.log('EJERCICIOS DEL PDF:', data)

  setEjercicios(data ?? [])

  console.log(
  'SET EJERCICIOS PDF EJECUTADO',
)
}

  async function guardarRespuesta(
  ejercicioId: number,
  respuesta: string,
  correcta: boolean,
  xpGanada: number,
  comentario: string,
  materialPath: string | null,
  ejercicioEnunciado: string,
  materialId: number | null,
temaId: number | null,
asignaturaId: number | null,
) {
console.log('MATERIAL ID EN GUARDAR RESPUESTA:', materialId)
console.log('GUARDANDO RESPUESTA:', {
  ejercicioId,
  respuesta,
  correcta,
  xpGanada,
  comentario,
  materialPath,
  ejercicioEnunciado,
  materialId,
})

    const { data, error } = await supabase
      .from('respuestas_ejercicios')
      .insert({
  ejercicio_id: ejercicioId,
  respuesta: respuesta,
  correcta: correcta,
  xp_ganada: xpGanada,
  comentario: comentario,
  enunciado_ejercicio: ejercicioEnunciado,
  material_path: materialPath,
  material_id: materialId,
  tema_id: temaId,
  asignatura_id: asignaturaId,
  
})

console.log('RESULTADO INSERT RESPUESTA:', {
  data,
  error,
})

console.log('DATOS QUE VOY A GUARDAR:', {
  ejercicioId,
  respuesta,
  correcta,
  xpGanada,
  comentario,
  ejercicioEnunciado,
  materialPath,
  materialId,
})
    if (error) {
      console.error(
        'Error guardando respuesta:',
        error,
      )

      window.alert(
        `ERROR: ${error.message}`,
      )

      return
    }

  
    await cargarProgreso()
    
    if (correcta && materialPath && materialId) {
  const { error: errorBorrado } = await supabase
  .from('ejercicios')
  .delete()
  .eq('id', ejercicioId)

if (errorBorrado) {
  console.error('ERROR BORRANDO EJERCICIO:', errorBorrado)
  return
}

  setEjercicios((ejerciciosActuales) =>
    ejerciciosActuales.filter(
      (ejercicio) => ejercicio.id !== ejercicioId
    )
  )

  const { data: ejerciciosRestantes } =
  await supabase
    .from('ejercicios')
    .select('id')
    .eq('material_id', materialId)

if (!ejerciciosRestantes || ejerciciosRestantes.length === 0) {
  return
}

  try {
    const { data: material } = await supabase
      .from('materiales')
      .select('id, nombre_archivo, ruta_archivo')
      .eq('ruta_archivo', materialPath)
      .single()

    if (!material) {
      return
    }

    const { data: materialUrl } =
      supabase.storage
        .from('Materiales')
        .getPublicUrl(material.ruta_archivo)

    const respuestaPdf =
      await fetch(materialUrl.publicUrl)

    const blob =
      await respuestaPdf.blob()

    const archivo = new File(
      [blob],
      material.nombre_archivo,
      {
        type: 'application/pdf',
      },
    )

console.log(
  'AÑADIENDO PDF - ASIGNATURA:',
  asignaturaSeleccionadaId,
)

    const textoPdf =
      await extraerTextoPdf(archivo)

       const [nuevoEjercicio] = await generarEjerciciosSinRepetir(
      textoPdf,
      temaId,
      1,
    )
  
    const { data: ejercicioInsertado, error } =
      await supabase
        .from('ejercicios')
        .insert({
          tema_id: temaSeleccionado?.id,
          asignatura_id: asignaturaSeleccionadaId,
          material_path: materialPath,
          material_id: materialId,
          titulo: nuevoEjercicio.titulo,
          enunciado: nuevoEjercicio.enunciado,
          solucion: nuevoEjercicio.solucion,
          tipo: 'practica',
          dificultad: nuevoEjercicio.dificultad,
          xp: nuevoEjercicio.xp,
        })
        .select(
  'id, titulo, enunciado, tipo, dificultad, xp, material_id',
)
        .single()

    if (error) {
      throw error
    }

    if (ejercicioInsertado) {
      setEjercicios((ejerciciosActuales) => [
        ...ejerciciosActuales,
        ejercicioInsertado,
      ])
    }
  } catch (error) {
    console.error(
      'Error generando ejercicio de reemplazo:',
      error,
    )
  }
}
  }

  async function corregirRespuesta(
    ejercicioId: number,
    respuesta: string,
  ) {
    setCorrigiendoRespuesta(ejercicioId)
    const { data: ejercicio, error } =
      await supabase
        .from('ejercicios')
        .select('enunciado, solucion, dificultad, xp, material_path, material_id, tema_id, asignatura_id')
        .eq('id', ejercicioId)
        .single()

    if (error || !ejercicio) {
      console.error(
        'Error cargando ejercicio para corregir:',
        error,
      )

      window.alert(
        'No se ha podido cargar el ejercicio.',
      )

      return
    }

    const { data: respuestasAnteriores, error: errorRespuestas } =
  await supabase
    .from('respuestas_ejercicios')
    .select('id, correcta')
    .eq('ejercicio_id', ejercicioId)

if (errorRespuestas) {
  console.error(
    'Error cargando intentos anteriores:',
    errorRespuestas,
  )

  return
}

const numeroIntento =
  (respuestasAnteriores?.length ?? 0) + 1

console.log(
  'INTENTO DEL EJERCICIO:',
  numeroIntento,
)

    try {
      const respuestaIA = await fetch(
        API_IA + '/corregir',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            enunciado: ejercicio.enunciado,
            solucion: ejercicio.solucion,
            respuesta: respuesta,
            dificultad: ejercicio.dificultad,
            xp: ejercicio.xp,
          }),
        },
      )

      if (!respuestaIA.ok) {
        throw new Error(
          `El servidor IA respondió con ${respuestaIA.status}`,
        )
      }

      const correccion =

        await respuestaIA.json()

      console.log(
        'Corrección IA:',
        correccion,
      )

      console.log('XP EJERCICIO:', ejercicio.xp)
      console.log('SOLUCIÓN:', ejercicio.solucion)
      console.log('CORRECTA:', correccion.correcta)
      console.log('MATERIAL ID DEL EJERCICIO:', ejercicio.material_id)

      console.log('ASIGNATURA ID DEL EJERCICIO:',ejercicio.asignatura_id,)

      await guardarRespuesta(
  ejercicioId,
  respuesta,
  correccion.correcta,
  correccion.correcta ? ejercicio.xp : 0,
  correccion.comentario,
  ejercicio.material_path,
ejercicio.enunciado,
ejercicio.material_id,
ejercicio.tema_id,
ejercicio.asignatura_id,
)

setCorrigiendoRespuesta(null)

            setCorrecciones((actuales) => ({
        ...actuales,
        [ejercicioId]: {
          correcta: correccion.correcta,
          xp_ganada: correccion.correcta ? ejercicio.xp : 0,
          comentario: correccion.comentario,
          intento: numeroIntento,
          solucion:
            !correccion.correcta && numeroIntento >= 3
              ? ejercicio.solucion
              : undefined,
        },
      }))
      
      setCorrigiendoRespuesta(null)

    } catch (error) { 
      setCorrigiendoRespuesta(null)
      console.error(
        'Error conectando con la IA:',
        error,
      )

      window.alert(
        'No se ha podido conectar con la IA local.',
      )
    }
  }

    async function cargarUltimaRespuesta(ejercicioId: number) {
    const { data, error } = await supabase
      .from('respuestas_ejercicios')
      .select('respuesta, correcta, xp_ganada, comentario')
      .eq('ejercicio_id', ejercicioId)
      .order('id', { ascending: false })

    if (error) {
      console.error('Error cargando respuesta:', error)
      return
    }

    if (!data || data.length === 0) {
      return
    }

    const ultima = data[0]

    setCorrecciones((actuales) => ({
      ...actuales,
      [ejercicioId]: {
        correcta: ultima.correcta,
        xp_ganada: ultima.xp_ganada,
        comentario: ultima.comentario,
        intento: data.length,
        solucion: actuales[ejercicioId]?.solucion,
      },
    }))
  }

  async function cargarTemasPendientes() {
    setCargandoPendientes(true)

    const {
      data: temasData,
      error: temasError,
    } = await supabase
      .from('temas')
      .select('id, nombre, asignatura_id')
      .order('id', {
        ascending: true,
        
      })

    if (temasError) {
      console.error(
        'Error cargando temas pendientes:',
        temasError,
      )

      setCargandoPendientes(false)
      return
    }

    const {
      data: asignaturasData,
      error: asignaturasError,
    } = await supabase
      .from('asignaturas')
      .select('id, nombre')
      console.log('ASIGNATURAS:', asignaturasData)

    if (asignaturasError) {
      console.error(
        'Error cargando asignaturas:',
        asignaturasError,
      )

      setCargandoPendientes(false)
      return
    }

    const resultado =
      (temasData ?? [])
        .slice(0, 6)
        .map((tema) => {
          const asignatura =
            (asignaturasData ?? []).find(
              (item) =>
                item.id === tema.asignatura_id,
            )

          return {
  id: tema.id,
  nombre: tema.nombre,
  asignatura:
    asignatura?.nombre ??
    'Asignatura',
  asignaturaId: tema.asignatura_id,
}
        })

    setTemasPendientes(resultado)
    setCargandoPendientes(false)
  }

  /*
   * NUEVO:
   * Abre directamente un tema desde
   * "Temas pendientes" del inicio.
   */
  async function abrirTemaPendiente(
    temaId: number,
  ) {
    try {
      const {
        data: tema,
        error: temaError,
      } = await supabase
        .from('temas')
        .select('id, nombre, asignatura_id')
        .eq('id', temaId)
        .single()

      if (temaError || !tema) {
        console.error(
          'Error cargando tema pendiente:',
          temaError,
        )

        window.alert(
          'No se ha podido abrir el tema.',
        )

        return
      }

      const {
        data: asignatura,
        error: asignaturaError,
      } = await supabase
        .from('asignaturas')
        .select('id, nombre')
        .eq('id', tema.asignatura_id)
        .single()

      if (
        asignaturaError ||
        !asignatura
      ) {
        console.error(
          'Error cargando asignatura del tema:',
          asignaturaError,
        )

        window.alert(
          'No se ha podido encontrar la asignatura.',
        )

        return
      }

      const materiales =
        await cargarMaterialesDeTema(
          tema.id,
        )

      const temaActualizado: Topic = {
        id: tema.id,
        name: tema.nombre,
        materials: materiales,
      }

      setAsignaturaSeleccionadaId(
        asignatura.id,
      )

      setAsignaturaSeleccionada(
        asignatura.nombre,
      )

      setTemaSeleccionado(
        temaActualizado,
      )

      setNombreTemaEditado(
        temaActualizado.name,
      )

      setEditandoNombre(false)

      setPantalla('tema')
    } catch (error) {
      console.error(
        'Error abriendo tema pendiente:',
        error,
      )

      window.alert(
        'No se ha podido abrir el tema.',
      )
    }
  }

  function entrarEnAsignatura(
    id: number,
    nombre: string,
  ) {
    setAsignaturaSeleccionadaId(id)
    setAsignaturaSeleccionada(nombre)
    setTemaSeleccionado(null)
    setPantalla('assignatura')
  }

  useEffect(() => {
    if (!asignaturaSeleccionadaId) {
      return
    }

    cargarTemas(asignaturaSeleccionadaId)
  }, [asignaturaSeleccionadaId])

    useEffect(() => {
    if (!usuarioId) {
      return
    }

    cargarTemasPendientes()
  }, [usuarioId])

  useEffect(() => {
    if (!temaSeleccionado) {
      return
    }
    
    cargarEjercicios(temaSeleccionado.id)
  }, [temaSeleccionado])

  async function cargarTemas(
    asignaturaId: number,
  ) {
    setCargandoTemas(true)
    setErrorTemas(null)

    const { data: temasData, error: temasError } =
      await supabase
        .from('temas')
        .select('id, nombre')
        .eq('asignatura_id', asignaturaId)
        .order('id', {
          ascending: true,
        })

    if (temasError) {
      console.error(
        'Error cargando temas:',
        temasError,
      )

      setErrorTemas(
        'No se han podido cargar los temas.',
      )

      setCargandoTemas(false)
      return
    }

    const idsTemas =
      (temasData ?? []).map(
        (tema) => tema.id,
      )

    let materialesData: {
      id: number
      tema_id: number
      nombre_archivo: string
      ruta_archivo: string
      tipo: 'principal' | 'adicional'
    }[] = []

    if (idsTemas.length > 0) {
      const {
        data,
        error: materialesError,
      } = await supabase
        .from('materiales')
        .select(
          'id, tema_id, nombre_archivo, ruta_archivo, tipo',
        )
        .in('tema_id', idsTemas)
        .order('id', {
          ascending: true,
        })

      if (materialesError) {
        console.error(
          'Error cargando materiales:',
          materialesError,
        )

        setErrorTemas(
          'No se han podido cargar los PDFs.',
        )

        setCargandoTemas(false)
        return
      }

      materialesData = data ?? []
    }

    const temasConvertidos: Topic[] =
      (temasData ?? []).map(
        (tema) => ({
          id: tema.id,
          name: tema.nombre,
          materials:
            materialesData
              .filter(
                (material) =>
                  material.tema_id ===
                  tema.id,
              )
              .map(
                (material) => ({
                  id: material.id,
                  fileName:
                    material.nombre_archivo,
                  path:
                    material.ruta_archivo,
                  tipo: material.tipo,
                }),
              ),
        }),
      )

    setTemas(temasConvertidos)
    setCargandoTemas(false)
  }

  async function cargarMaterialesDeTema(
    temaId: number,
  ): Promise<Material[]> {
    const { data, error } =
      await supabase
        .from('materiales')
        .select(
          'id, nombre_archivo, ruta_archivo, tipo',
        )
        .eq('tema_id', temaId)
        .order('id', {
          ascending: true,
        })

    if (error) {
      console.error(
        'Error cargando materiales:',
        error,
      )

      return []
    }

    return (data ?? []).map(
      (material) => ({
        id: material.id,
        fileName:
          material.nombre_archivo,
        path:
          material.ruta_archivo,
        tipo: material.tipo,
      }),
    )
  }

  function abrirFormularioTema() {
    setNombreNuevoTema('')
    setMostrarFormularioTema(true)
  }

  function cancelarFormularioTema() {
    setNombreNuevoTema('')
    setMostrarFormularioTema(false)
  }

  async function crearTema(
    event: React.FormEvent,
  ) {
    event.preventDefault()

    const nombre = nombreNuevoTema.trim()

    if (
      !nombre ||
      !asignaturaSeleccionadaId
    ) {
      return
    }

    const { data, error } =
      await supabase
        .from('temas')
        .insert({
          asignatura_id:
            asignaturaSeleccionadaId,
          nombre,
        })
        .select('id, nombre')
        .single()

    if (error) {
      console.error(
        'Error creando tema:',
        error,
      )

      window.alert(
        'No se ha podido crear el tema.',
      )

      return
    }

    const nuevoTema: Topic = {
      id: data.id,
      name: data.nombre,
      materials: [],
    }

    setTemas((temasActuales) => [
      ...temasActuales,
      nuevoTema,
    ])

    setMostrarFormularioTema(false)
    setNombreNuevoTema('')
  }

  async function entrarEnTema(
    tema: Topic,
  ) {
    const materiales =
      await cargarMaterialesDeTema(
        tema.id,
      )

    const temaActualizado: Topic = {
      ...tema,
      materials: materiales,
    }

    setTemaSeleccionado(
      temaActualizado,
    )

    setNombreTemaEditado(
      temaActualizado.name,
    )

    setPantalla('tema')
  }

  async function eliminarTema(
    id: number,
  ) {
    const confirmar = window.confirm(
      '¿Seguro que quieres eliminar este tema y todos sus PDFs?',
    )

    if (!confirmar) {
      return
    }

    const materiales =
      await cargarMaterialesDeTema(id)

    if (materiales.length > 0) {
      const rutas = materiales.map(
        (material) => material.path,
      )

      const {
        error: storageError,
      } = await supabase.storage
        .from('Materiales')
        .remove(rutas)

      if (storageError) {
        console.error(
          'Error eliminando archivos:',
          storageError,
        )
      }
    }

    const { error } =
      await supabase
        .from('temas')
        .delete()
        .eq('id', id)

    if (error) {
      console.error(
        'Error eliminando tema:',
        error,
      )

      window.alert(
        'No se ha podido eliminar el tema.',
      )

      return
    }

    setTemas((temasActuales) =>
      temasActuales.filter(
        (tema) =>
          tema.id !== id,
      ),
    )

    setTemaSeleccionado(null)
    setPantalla('assignatura')
  }

  async function guardarNombreTema(
    event: React.FormEvent,
  ) {
    event.preventDefault()

    if (!temaSeleccionado) {
      return
    }

    const nuevoNombre =
      nombreTemaEditado.trim()

    if (!nuevoNombre) {
      return
    }

    const { data, error } =
      await supabase
        .from('temas')
        .update({
          nombre: nuevoNombre,
        })
        .eq(
          'id',
          temaSeleccionado.id,
        )
        .select('id, nombre')
        .single()

    if (error) {
      console.error(
        'Error actualizando tema:',
        error,
      )

      window.alert(
        'No se ha podido actualizar el tema.',
      )

      return
    }

    const temaActualizado: Topic = {
      ...temaSeleccionado,
      name: data.nombre,
    }

    setTemas((temasActuales) =>
      temasActuales.map((tema) =>
        tema.id ===
          temaActualizado.id
          ? temaActualizado
          : tema,
      ),
    )

    setTemaSeleccionado(
      temaActualizado,
    )

    setEditandoNombre(false)
  }

  async function subirArchivo(
    archivo: File,
    temaId: number,
    tipo: 'principal' | 'adicional',
  ): Promise<Material | null> {
    const extension =
      archivo.name.includes('.')
        ? archivo.name
          .split('.')
          .pop()
        : 'pdf'

    const nombreUnico =
      `${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 10)}.${extension}`

    const ruta =
      `${temaId}/${nombreUnico}`

    const {
      error: uploadError,
    } = await supabase.storage
      .from('Materiales')
      .upload(
        ruta,
        archivo,
        {
          contentType:
            archivo.type ||
            'application/pdf',
          upsert: false,
        },
      )

    if (uploadError) {
      console.error(
        'Error subiendo PDF:',
        uploadError,
      )

      return null
    }

    const {
      data,
      error: materialError,
    } = await supabase
      .from('materiales')
      .insert({
        tema_id: temaId,
        nombre_archivo:
          archivo.name,
        ruta_archivo: ruta,
        tipo,
      })
      .select(
        'id, nombre_archivo, ruta_archivo, tipo',
      )
      .single()

    if (materialError) {
      console.error(
        'Error guardando material:',
        materialError,
      )

      await supabase.storage
        .from('Materiales')
        .remove([ruta])

      return null
    }

    return {
      id: data.id,
      fileName:
        data.nombre_archivo,
      path:
        data.ruta_archivo,
      tipo: data.tipo,
    }
  }

async function extraerTextoPdf(archivo: File): Promise<string> {
  const clave = `${archivo.name}|${archivo.size}`
  const guardado = cacheTextoPdf.get(clave)

  if (guardado !== undefined) {
    return guardado
  }

  const formulario = new FormData()

  formulario.append('pdf', archivo)

  const respuesta = await fetch(API_IA + '/extraer-pdf', {
    method: 'POST',
    body: formulario,
  })

  if (!respuesta.ok) {
    throw new Error('No se ha podido extraer el PDF.')
  }

  const datos = await respuesta.json()
  const texto = String(datos.texto ?? '')

  cacheTextoPdf.set(clave, texto)

  return texto
}

async function generarEjerciciosAdicional(
  material: Material,
) {
  
  console.log(
    'BOTÓN GENERAR EJERCICIOS ADICIONAL:',
    material.fileName,
  )

  if (!temaSeleccionado) {
    return
  }

  setGenerandoEjercicios(material.id)

  // Comprobar si este PDF ya tiene ejercicios pendientes
const { data: ejerciciosPendientes, error: errorComprobacion } =
  await supabase
    .from('ejercicios')
    .select('id, enunciado')
    .eq('material_id', material.id)

if (errorComprobacion) {
  console.error(
    'ERROR COMPROBANDO EJERCICIOS DEL PDF:',
    errorComprobacion
  )
  return
}

if (
  ejerciciosPendientes &&
  ejerciciosPendientes.length > 0
) {
  window.alert(
    'Aquest PDF ja té exercicis pendents.'
  )
  return
}

  try {
    const { data } =
      supabase.storage
        .from('Materiales')
        .getPublicUrl(material.path)

    const respuestaPdf =
      await fetch(data.publicUrl)

    const blob =
      await respuestaPdf.blob()

    const archivo = new File(
      [blob],
      material.fileName,
      {
        type: 'application/pdf',
      },
    )

    console.log(
      'EXTRAYENDO TEXTO DEL PDF...',
    )

    const textoPdf =
      await extraerTextoPdf(archivo)

        const ejerciciosGenerados = {
      ejercicios: await generarEjerciciosSinRepetir(
        textoPdf,
        temaSeleccionado.id,
        5,
      ),
    }

    const ejerciciosParaGuardar =
  ejerciciosGenerados.ejercicios.map(
    (ejercicio: any) => ({
      tema_id: temaSeleccionado.id,
      asignatura_id: asignaturaSeleccionadaId,
      material_id: material.id,
      material_path: material.path,
      titulo: ejercicio.titulo,
      enunciado: ejercicio.enunciado,
      solucion: ejercicio.solucion,
      tipo: 'practica',
      dificultad: ejercicio.dificultad,
      xp:
        ejercicio.dificultad === 'dificil'
          ? 30
          : ejercicio.dificultad === 'media'
            ? 20
            : 10,
    }),
  )

console.log(
  'EJERCICIOS PARA GUARDAR:',
  ejerciciosParaGuardar,
)

console.log(
  'DATOS REALES:',
  JSON.stringify(ejerciciosParaGuardar)

)
    const { error } =
      await supabase
        .from('ejercicios')
        .insert(
          ejerciciosParaGuardar,
        )

    if (error) {
      throw error
    }

    await cargarEjerciciosPdf(material.id)

    window.alert(
      '5 ejercicios generados correctamente.',
    )

    setGenerandoEjercicios(null)

  } catch (error) {
    console.error(
      'ERROR GENERANDO EJERCICIOS:',
      error,
    )

    setGenerandoEjercicios(null)

    window.alert(
      'No se han podido generar los ejercicios.',
    )
    
  }
}

  async function añadirPdf(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const archivos =
      event.target.files

    if (
      !archivos ||
      !temaSeleccionado
    ) {
      return
    }

    setSubiendoPdf(true)
  

try {
  const archivosArray =
    Array.from(archivos)

    const hayPrincipal =
      temaSeleccionado.materials.some(
        (material) =>
          material.tipo ===
          'principal',
      )

    const nuevosMateriales: Material[] =
      []

    for (
      let index = 0;
      index <
      archivosArray.length;
      index++
    ) {
      const tipo =
        !hayPrincipal &&
          index === 0
          ? 'principal'
          : 'adicional'

      const material =
        await subirArchivo(
          archivosArray[index],
          temaSeleccionado.id,
          tipo,
        )

        console.log('MATERIAL DEVUELTO:', material)

        const { data: materialComprobado, error: errorMaterial } =
  await supabase
    .from('materiales')
    .select('id, nombre_archivo, ruta_archivo')
    .eq('id', material!.id)
    .single()

console.log(
  'MATERIAL EN SUPABASE:',
  materialComprobado,
  errorMaterial,
)

      if (material) {
  nuevosMateriales.push(
    material,
  )

  console.log('PDF SUBIDO CORRECTAMENTE')

  if (tipo === 'principal') {
    setGenerandoPrincipal(true)
    setSubiendoPdf(true)

  console.log('VOY A EXTRAER EL PDF AHORA')

const { error: errorEjerciciosAntiguos } =
  await supabase
    .from('ejercicios')
    .delete()
    .eq('tema_id', temaSeleccionado.id)
    .is('material_path', null)

if (errorEjerciciosAntiguos) {
  console.error(
    'ERROR ELIMINANDO EJERCICIOS ANTIGUOS:',
    errorEjerciciosAntiguos,
  )
  return
}

  extraerTextoPdf(archivosArray[index])
    .then(async (textoPdf) => {
      console.log(
        'TEXTO EXTRAÍDO DEL PDF:',
        textoPdf,
      )

      const respuestaEjercicios =
        await fetch(
          API_IA + '/generar-ejercicios',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              texto: textoPdf,
            }),
          },
        )

      if (!respuestaEjercicios.ok) {
        throw new Error(
          'No se han podido generar los ejercicios.',
        )
      }

      const ejerciciosGenerados = {
        ejercicios: await generarEjerciciosSinRepetir(
          textoPdf,
          temaSeleccionado.id,
          5,
        ),
      }

      console.log(
        'EJERCICIOS GENERADOS DESDE EL PDF:',
        ejerciciosGenerados,
      )

      console.log(
  'PRIMER EJERCICIO GENERADO:',
  ejerciciosGenerados.ejercicios[0],
)

      console.log('NUEVOS MATERIALES:', nuevosMateriales)

      const ejerciciosParaGuardar =
  ejerciciosGenerados.ejercicios.map(
    (ejercicio: any) => {
      let xp = 10

      if (ejercicio.dificultad === 'media') {
        xp = 20
      }

      if (ejercicio.dificultad === 'dificil') {
        xp = 30
      }

      xp = Number(xp) || 10

      return {
        tema_id: temaSeleccionado.id,
        asignatura_id: asignaturaSeleccionadaId,
        material_id: material.id,
        titulo: ejercicio.titulo,
        enunciado: ejercicio.enunciado,
        solucion: ejercicio.solucion,
        tipo: 'practica',
        dificultad: ejercicio.dificultad ?? 'facil',
xp: ejercicio.dificultad === 'dificil'
  ? 30
  : ejercicio.dificultad === 'media'
    ? 20
    : 10,
      }
    },
  )

      const { error } =
        await supabase
          .from('ejercicios')
          .insert(ejerciciosParaGuardar)

      if (error) {
        console.error(
          'ERROR GUARDANDO EJERCICIOS:',
          error,
        )

        return
      }

      console.log(
        'EJERCICIOS GUARDADOS EN SUPABASE',
      )

      await cargarEjercicios(
        temaSeleccionado.id,
      )
      setGenerandoPrincipal(false)
    })
    .catch((error) => {
      console.error(
        'ERROR GENERANDO EJERCICIOS:',
        error,
      )
      setGenerandoPrincipal(false)
    })
}
}
    }

    const temaActualizado: Topic = {
      ...temaSeleccionado,
      materials: [
        ...temaSeleccionado.materials,
        ...nuevosMateriales,
      ],
    }

    setTemaSeleccionado(
      temaActualizado,
    )

    setTemas((temasActuales) =>
      temasActuales.map((tema) =>
        tema.id ===
          temaActualizado.id
          ? temaActualizado
          : tema,
      ),
    )

    setSubiendoPdf(false)
} finally {
  setSubiendoPdf(false)
  setGenerandoPrincipal(false)
}
    event.target.value = ''
  }

  async function cambiarPdfPrincipal(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const archivo =
      event.target.files?.[0]

    if (
      !archivo ||
      !temaSeleccionado
    ) {
      return
    }

    setSubiendoPdf(true)

    const materialesAnteriores =
      temaSeleccionado.materials

    const anterioresPrincipales =
      materialesAnteriores.filter(
        (material) =>
          material.tipo ===
          'principal',
      )

    const materialesSinPrincipal =
      materialesAnteriores.filter(
        (material) =>
          material.tipo !==
          'principal',
      )

      for (const material of anterioresPrincipales) {
  const { error: errorEjerciciosAntiguos } =
    await supabase
      .from('ejercicios')
      .delete()
      .eq('material_id', material.id)

  if (errorEjerciciosAntiguos) {
    console.error(
      'ERROR ELIMINANDO EJERCICIOS ANTIGUOS:',
      errorEjerciciosAntiguos,
    )
    setSubiendoPdf(false)
    return
  }
}

    const nuevoMaterial =
      await subirArchivo(
        archivo,
        temaSeleccionado.id,
        'principal',
      )

    if (!nuevoMaterial) {
      setSubiendoPdf(false)
      event.target.value = ''
      return
    }

    for (
      const material of anterioresPrincipales
    ) {
      await supabase.storage
        .from('Materiales')
        .remove([
          material.path,
        ])

      await supabase
        .from('materiales')
        .delete()
        .eq(
          'id',
          material.id,
        )
    }

    console.log(
    'ASIGNATURA AL GENERAR PDF:',
    asignaturaSeleccionadaId,
    )

    const textoPdf =
  await extraerTextoPdf(archivo)

const ejerciciosGenerados = {
  ejercicios: await generarEjerciciosSinRepetir(
    textoPdf,
    temaSeleccionado.id,
    5,
  ),
}

const ejerciciosParaGuardar =
  ejerciciosGenerados.ejercicios.map(
    (ejercicio: any) => ({
      tema_id: temaSeleccionado.id,
      asignatura_id: asignaturaSeleccionadaId,
      material_id: nuevoMaterial.id,
      titulo: ejercicio.titulo,
      enunciado: ejercicio.enunciado,
      solucion: ejercicio.solucion,
      tipo: 'practica',
      dificultad: ejercicio.dificultad,
      xp:
        ejercicio.dificultad === 'dificil'
          ? 30
          : ejercicio.dificultad === 'media'
            ? 20
            : 10,
    }),
  )

const { error: errorEjercicios } =
  await supabase
    .from('ejercicios')
    .insert(ejerciciosParaGuardar)

if (errorEjercicios) {
  console.error(
    'ERROR GUARDANDO EJERCICIOS NUEVOS:',
    errorEjercicios,
  )
}

    const temaActualizado: Topic = {
      ...temaSeleccionado,
      materials: [
        nuevoMaterial,
        ...materialesSinPrincipal,
      ],
    }

    setTemaSeleccionado(
      temaActualizado,
    )

    setTemas((temasActuales) =>
      temasActuales.map((tema) =>
        tema.id ===
          temaActualizado.id
          ? temaActualizado
          : tema,
      ),
    )

    setSubiendoPdf(false)
    event.target.value = ''
  }

  async function eliminarMaterial(
    id: number,
  ) {
    if (!temaSeleccionado) {
      return
    }

    const material =
      temaSeleccionado.materials.find(
        (item) =>
          item.id === id,
      )

    if (!material) {
      return
    }

    const confirmar =
      window.confirm(
        `¿Seguro que quieres eliminar "${material.fileName}"?`,
      )

    if (!confirmar) {
      return
    }

    const {
      error: storageError,
    } = await supabase.storage
      .from('Materiales')
      .remove([
        material.path,
      ])

    if (storageError) {
      console.error(
        'Error eliminando archivo:',
        storageError,
      )
    }

    if (material.tipo === 'principal') {
  const { error: errorEjercicios } =
    await supabase
      .from('ejercicios')
      .delete()
      .eq('material_id', material.id)

  if (errorEjercicios) {
    console.error(
      'Error eliminando ejercicios principales:',
      errorEjercicios,
    )
  }
}

    const { error } =
      await supabase
        .from('materiales')
        .delete()
        .eq(
          'id',
          material.id,
        )

    if (error) {
      console.error(
        'Error eliminando material:',
        error,
      )

      window.alert(
        'No se ha podido eliminar el PDF.',
      )

      return
    }

    let nuevosMateriales =
      temaSeleccionado.materials.filter(
        (item) =>
          item.id !== id,
      )

    

    const temaActualizado: Topic = {
      ...temaSeleccionado,
      materials:
        nuevosMateriales,
    }

    setTemaSeleccionado(
      temaActualizado,
    )

    setTemas((temasActuales) =>
      temasActuales.map((tema) =>
        tema.id ===
          temaActualizado.id
          ? temaActualizado
          : tema,
      ),
    )
  }

      function abrirPdf(material: Material) {
    setMaterialVisor(material)
    setPaginaVisor(1)
    setPanelVisor('subrayados')
    setPantalla('visor')
  }

  function volverAAsignaturas() {
    setTemaSeleccionado(null)
    setAsignaturaSeleccionadaId(null)
    setAsignaturaSeleccionada(null)
    setTemas([])
    setPantalla('assignatures')
  }

  function reanalizarConIA() {
    window.alert(
      'La reanàlisi amb IA quedarà connectada quan incorporem el sistema d’IA.',
    )
  }

  async function cargarCorrecciones(idsEjercicios: number[]) {
    if (idsEjercicios.length === 0) {
      return
    }

    const { data: respuestasData, error } = await supabase
      .from('respuestas_ejercicios')
      .select('ejercicio_id, correcta, xp_ganada, comentario')
      .in('ejercicio_id', idsEjercicios)
      .order('id', { ascending: true })

    if (error) {
      console.error('Error cargando correcciones:', error)
      return
    }

    // Agrupar las respuestas de cada ejercicio (de la más antigua a la más reciente)
    const porEjercicio: Record<
      number,
      { correcta: boolean; xp_ganada: number; comentario: string | null }[]
    > = {}

    ;(respuestasData ?? []).forEach((respuesta) => {
      if (!porEjercicio[respuesta.ejercicio_id]) {
        porEjercicio[respuesta.ejercicio_id] = []
      }

      porEjercicio[respuesta.ejercicio_id].push(respuesta)
    })

    const idsConRespuestas = Object.keys(porEjercicio).map(Number)

    // Los ejercicios con 3 fallos necesitan su solución
    const idsAgotados = idsConRespuestas.filter((id) => {
      const lista = porEjercicio[id]
      return !lista[lista.length - 1].correcta && lista.length >= 3
    })

    const soluciones: Record<number, string> = {}

    if (idsAgotados.length > 0) {
      const { data: solucionesData } = await supabase
        .from('ejercicios')
        .select('id, solucion')
        .in('id', idsAgotados)

      ;(solucionesData ?? []).forEach((ejercicio) => {
        soluciones[ejercicio.id] = ejercicio.solucion
      })
    }

    const nuevas: typeof correcciones = {}

    idsConRespuestas.forEach((id) => {
      const lista = porEjercicio[id]
      const ultima = lista[lista.length - 1]

      nuevas[id] = {
        correcta: ultima.correcta,
        xp_ganada: ultima.xp_ganada,
        comentario: ultima.comentario,
        intento: lista.length,
        solucion: soluciones[id],
      }
    })

    setCorrecciones((actuales) => ({
      ...actuales,
      ...nuevas,
    }))
  }

  useEffect(() => {
    if (ejercicios.length === 0) {
      return
    }

    cargarCorrecciones(ejercicios.map((ejercicio) => ejercicio.id))
  }, [ejercicios])

  function intentosAgotados(ejercicioId: number) {
    const c = correcciones[ejercicioId]
    return !!c && !c.correcta && c.intento >= 3
  }

  async function eliminarEjercicio(ejercicioId: number) {
    setEliminandoEjercicio(ejercicioId)

    try {
      const { data: ejercicio, error } = await supabase
        .from('ejercicios')
        .select('material_id, material_path, tema_id, asignatura_id')
        .eq('id', ejercicioId)
        .single()

      if (error || !ejercicio) {
        console.error('Error cargando ejercicio a eliminar:', error)
        window.alert('No se ha podido cargar el ejercicio.')
        return
      }

      const { error: errorBorrado } = await supabase
        .from('ejercicios')
        .delete()
        .eq('id', ejercicioId)

      if (errorBorrado) {
        console.error('Error eliminando ejercicio:', errorBorrado)
        window.alert('No se ha podido eliminar el ejercicio.')
        return
      }

      setEjercicios((actuales) =>
        actuales.filter((e) => e.id !== ejercicioId),
      )

      setCorrecciones((actuales) => {
        const copia = { ...actuales }
        delete copia[ejercicioId]
        return copia
      })

      // Sin material asociado no se puede generar reemplazo
      if (!ejercicio.material_id) {
        return
      }

      const { data: material } = await supabase
        .from('materiales')
        .select('id, nombre_archivo, ruta_archivo')
        .eq('id', ejercicio.material_id)
        .single()

      if (!material) {
        return
      }

      const { data: materialUrl } = supabase.storage
        .from('Materiales')
        .getPublicUrl(material.ruta_archivo)

      const respuestaPdf = await fetch(materialUrl.publicUrl)
      const blob = await respuestaPdf.blob()

      const archivo = new File([blob], material.nombre_archivo, {
        type: 'application/pdf',
      })

      const textoPdf = await extraerTextoPdf(archivo)

            const [nuevo] = await generarEjerciciosSinRepetir(
        textoPdf,
        ejercicio.tema_id,
        1,
      ) 

      const { data: insertado, error: errorInsert } = await supabase
        .from('ejercicios')
        .insert({
          tema_id: ejercicio.tema_id,
          asignatura_id: ejercicio.asignatura_id,
          material_id: ejercicio.material_id,
          material_path: ejercicio.material_path,
          titulo: nuevo.titulo,
          enunciado: nuevo.enunciado,
          solucion: nuevo.solucion,
          tipo: 'practica',
          dificultad: nuevo.dificultad,
          xp:
            nuevo.dificultad === 'dificil'
              ? 30
              : nuevo.dificultad === 'media'
                ? 20
                : 10,
        })
        .select('id, titulo, enunciado, tipo, dificultad, xp')
        .single()

      if (errorInsert) {
        throw errorInsert
      }

      if (insertado) {
        setEjercicios((actuales) => [...actuales, insertado])
      }
    } catch (error) {
      console.error('Error generando ejercicio de reemplazo:', error)
      window.alert('Se ha eliminado el ejercicio, pero no se ha podido generar el reemplazo.')
    } finally {
      setEliminandoEjercicio(null)
    }
  }

  const pdfPrincipal =
    temaSeleccionado?.materials.find(
      (material) =>
        material.tipo ===
        'principal',
    )

  const pdfsAdicionales =
    temaSeleccionado?.materials.filter(
      (material) =>
        material.tipo ===
        'adicional',
    ) ?? []

      if (cargandoSesion) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          color: '#9a9ab0',
        }}
      >
        Carregant...
      </div>
    )
  }

  if (!sesion) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '24px',
        }}
      >

        <form
          onSubmit={iniciarSesion}
          style={{ ...ESTILO_TARJETA, width: '100%', maxWidth: '380px' }}
        >

          <div style={{ textAlign: 'center', marginBottom: '20px' }}>

            <div
              style={{
                width: '56px',
                height: '56px',
                borderRadius: '16px',
                background: '#17171f',
                color: '#ffffff',
                display: 'grid',
                placeItems: 'center',
                fontWeight: 700,
                margin: '0 auto 12px',
              }}
            >
              GS
            </div>

            <h2>Accedeix al teu espai</h2>

          </div>

          <label
            htmlFor="email-login"
            style={{ display: 'block', margin: '12px 0 6px', fontWeight: 600 }}
          >
            Correu
          </label>

          <input
            id="email-login"
            type="email"
            autoComplete="email"
            required
            value={emailLogin}
            onChange={(event) => setEmailLogin(event.target.value)}
            style={ESTILO_SELECT}
          />

          <label
            htmlFor="password-login"
            style={{ display: 'block', margin: '12px 0 6px', fontWeight: 600 }}
          >
            Contrasenya
          </label>

          <input
            id="password-login"
            type="password"
            autoComplete="current-password"
            required
            value={passwordLogin}
            onChange={(event) => setPasswordLogin(event.target.value)}
            style={ESTILO_SELECT}
          />

          {errorLogin && (
            <p style={{ color: '#e5646e', marginTop: '12px' }}>
              {errorLogin}
            </p>
          )}

          <button
            className="app-button app-button-primary"
            type="submit"
            disabled={iniciandoSesion}
            style={{ width: '100%', marginTop: '20px' }}
          >
            {iniciandoSesion ? 'Entrant...' : 'Entrar'}
          </button>

        </form>

      </div>
    )
  }

  return (
    
    <div className="app">

          <style>{`
        .app-footer {
          position: fixed !important;
          left: 0 !important;
          right: 0 !important;
          bottom: 0 !important;
          z-index: 900 !important;
          margin: 0 !important;
          padding: 0 !important;
          min-height: 0 !important;
          height: auto !important;
          background: #ffffff !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          border-top: 1px solid #ececf4 !important;
          box-shadow: 0 -4px 20px rgba(109, 93, 252, 0.10) !important;
        }

        .app-footer .footer-inner {
          display: flex !important;
          align-items: center !important;
          justify-content: space-between !important;
          gap: 12px !important;
          width: 100% !important;
          max-width: 1000px !important;
          min-height: 0 !important;
          height: auto !important;
          margin: 0 auto !important;
          padding: 8px 20px !important;
          background: transparent !important;
          box-sizing: border-box !important;
        }

        .app-footer .footer-brand {
          gap: 10px !important;
        }

        .app-footer .footer-logo {
          width: 36px !important;
          height: 36px !important;
          min-width: 36px !important;
          font-size: 13px !important;
          border-radius: 10px !important;
        }

        .app-footer .footer-brand strong {
          font-size: 14px !important;
        }

        .app-footer .footer-brand span,
        .app-footer .footer-copy span {
          font-size: 12px !important;
        }

        .app-footer .footer-navigation {
          margin: 0 !important;
          padding: 0 !important;
        }

        .app-main {
          padding-bottom: 100px !important;
        }

        @media (max-width: 800px) {
          .app-footer .footer-brand,
          .app-footer .footer-copy {
            display: none !important;
          }

          .app-footer .footer-inner {
            justify-content: center !important;
          }
        }
      `}</style>
    
            <style>{`
        @keyframes pantalla-entrar {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: none; }
        }

        @keyframes esqueleto {
          0% { background-position: 100% 50%; }
          100% { background-position: 0 50%; }
        }

        html { scroll-behavior: smooth; }

        ::selection { background: rgba(109, 93, 252, 0.25); }

        :focus-visible {
          outline: 3px solid rgba(109, 93, 252, 0.45);
          outline-offset: 2px;
        }

        button, input, textarea, select { font-family: inherit; }
        button { touch-action: manipulation; }
        img { max-width: 100%; }

        .home-dashboard,
        .page-section,
        .topic-page {
          animation: pantalla-entrar 0.35s ease-out;
        }

        .app-button,
        .exercise-submit,
        .topic-open-button,
        .pending-item,
        .topic-card,
        .exercise-card {
          transition: transform 0.15s ease, box-shadow 0.2s ease, opacity 0.15s ease;
        }

        .app-button:hover:not(:disabled),
        .exercise-submit:hover:not(:disabled),
        .topic-open-button:hover:not(:disabled) {
          transform: translateY(-1px);
        }

        .app-button:active:not(:disabled),
        .exercise-submit:active:not(:disabled) {
          transform: scale(0.98);
        }

        .app-button:disabled,
        .exercise-submit:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }

        .pending-item:hover,
        .topic-card:hover,
        .exercise-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 12px 30px rgba(109, 93, 252, 0.12);
        }

        /* Esqueleto de carga en el inicio */
        .home-dashboard.cargando > div:not(.home-intro):not(.xp-hero):not(.recommendation-card) {
          background: linear-gradient(90deg, #f0f0f7 25%, #e4e4f1 37%, #f0f0f7 63%) !important;
          background-size: 400% 100%;
          animation: esqueleto 1.4s ease infinite;
          min-height: 120px;
          border-radius: 24px;
          pointer-events: none;
          box-shadow: none !important;
        }

        .home-dashboard.cargando > div:not(.home-intro):not(.xp-hero):not(.recommendation-card) * {
          visibility: hidden;
        }

        .app-footer {
          padding-bottom: env(safe-area-inset-bottom) !important;
        }

        @media (max-width: 700px) {
          .app-main {
            padding-left: 14px !important;
            padding-right: 14px !important;
          }

          .xp-hero-top,
          .xp-hero-bottom,
          .exercise-footer,
          .pdf-actions,
          .pdf-item-actions,
          .form-actions {
            flex-wrap: wrap !important;
            gap: 10px !important;
          }

          .pdf-main-card,
          .pdf-item,
          .topic-card {
            flex-direction: column !important;
            align-items: stretch !important;
          }

          .app-button,
          .exercise-submit {
            min-height: 44px;
          }

          input, select, textarea, .exercise-textarea {
            font-size: 16px !important;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after {
            animation: none !important;
            transition: none !important;
            scroll-behavior: auto !important;
          }
        }
      `}</style>

                          {estadoServidor !== 'ok' && !avisoCerrado && (
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 950,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            padding: '10px 16px',
            background: '#fff4e5',
            color: '#8a4b00',
            fontSize: '14px',
            borderBottom: '1px solid #ffd8a8',
          }}
        >
          <span>
            {estadoServidor === 'servidor'
              ? `⚠️ No hi ha connexió amb el servidor d'IA (${API_IA}). Engega'l amb node i torna-ho a provar.`
              : '⚠️ Ollama no respon. Obre Ollama perquè la IA funcioni.'}
          </span>

          <button
            type="button"
            onClick={() => setAvisoCerrado(true)}
            title="Tancar"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '16px',
              color: '#8a4b00',
            }}
          >
            ✕
          </button>
        </div>
      )}

          {logroNuevo && (
        <div
          style={{
            position: 'fixed',
            top: '16px',
            left: 0,
            right: 0,
            zIndex: 1100,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '14px 22px',
              borderRadius: '18px',
              background: '#ffffff',
              boxShadow: '0 12px 40px rgba(109, 93, 252, 0.35)',
              animation: 'nivel-aparecer 0.45s ease-out',
            }}
          >

            <span style={{ fontSize: '28px' }}>
              {logroNuevo.icono}
            </span>

            <div>

              <small style={{ color: '#6d5dfc', fontWeight: 700 }}>
                ASSOLIMENT DESBLOQUEJAT
              </small>

              <strong style={{ display: 'block' }}>
                {logroNuevo.titulo}
              </strong>

            </div>

          </div>

        </div>
      )}

      {nivelSubido !== null && (
        <div
          onClick={() => setNivelSubido(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            background: 'rgba(20, 16, 40, 0.55)',
            backdropFilter: 'blur(6px)',
            animation: 'nivel-fondo 0.3s ease-out',
          }}
        >

          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: '380px',
              padding: '40px 32px 32px',
              borderRadius: '28px',
              textAlign: 'center',
              background: '#ffffff',
              boxShadow: '0 30px 80px rgba(109, 93, 252, 0.35)',
              animation: 'nivel-aparecer 0.45s ease-out',
            }}
          >

            <div
              style={{
                fontSize: '64px',
                animation: 'nivel-rebote 1s ease-in-out infinite',
              }}
            >
              🎉
            </div>

            <span className="eyebrow">
              PUJADA DE NIVELL
            </span>

            <h2
              style={{
                fontSize: '56px',
                margin: '8px 0',
                color: '#6d5dfc',
              }}
            >
              Nivell {nivelSubido}
            </h2>

            <p
              style={{
                color: '#6b6b80',
                marginBottom: '24px',
              }}
            >
              Has superat els {(nivelSubido - 1) * 200} XP.
              Continua així!
            </p>

            <button
              className="app-button app-button-primary"
              type="button"
              onClick={() => setNivelSubido(null)}
            >
              Continuar
            </button>

          </div>

        </div>
      )}

      <header className="app-header">

        <button
          className="header-brand"
          type="button"
          onClick={() => setPantalla('inicio')}
        >
          <span className="header-brand-mark">
            GS
          </span>

          <span className="header-brand-text">
            <small>
              FORMACIÓ PROFESSIONAL
            </small>

            <strong>
              Marqueting i Publicitat
            </strong>
          </span>
        </button>

        <div className="header-status">
          <span className="header-status-dot" />

          <span>
            Espai d'estudi
          </span>
          
          <button
            type="button"
            onClick={cerrarSesion}
            title="Tancar sessió"
            style={{
              marginLeft: '12px',
              background: 'transparent',
              border: '1px solid #e0e0ee',
              borderRadius: '10px',
              padding: '4px 10px',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            Sortir
          </button>
        </div>

      </header>


      <main className="app-main" style={{ paddingBottom: '150px' }}>

               {pantalla === 'inicio' && (
                    <section className={cargandoDatos ? 'home-dashboard cargando' : 'home-dashboard'}>

            <div className="home-intro">

              <div className="home-intro-copy">

                <span className="eyebrow">
                  EL TEU ESPAI
                </span>

                <h1>
                  Hola, Kandeh
                  <span>.</span>
                </h1>

                <p>
                  Continua aprenent,
                  practica i avança al teu ritme.
                </p>

              </div>


                            <div
                className="profile-picture-wrapper"
                style={{ position: 'relative', overflow: 'visible' }}
              >

                {complementos.slice(0, 3).map((emoji, indice) => (
                  <span
                    key={emoji}
                    style={{
                      position: 'absolute',
                      zIndex: 2,
                      fontSize: '34px',
                      lineHeight: 1,
                      pointerEvents: 'none',
                      filter: 'drop-shadow(0 3px 6px rgba(0, 0, 0, 0.25))',
                      ...POSICIONES_COMPLEMENTO[indice],
                    }}
                  >
                    {emoji}
                  </span>
                ))}

                {fotoPerfil ? (
                  <img
                    src={fotoPerfil}
                    alt="Foto de perfil"
                    className="profile-picture"
                  />
                ) : (
                  <div className="profile-placeholder">
                    K
                  </div>
                )}

                <label
                  htmlFor="foto-perfil"
                  className="profile-edit"
                  title="Cambiar foto"
                >
                  ✎
                </label>

                <input
                  id="foto-perfil"
                  type="file"
                  accept="image/*"
                  onChange={cambiarFotoPerfil}
                  hidden
                />

              </div>

            </div>


            <div className="xp-hero">

              <div className="xp-hero-top">

                <div>

                  <span className="eyebrow eyebrow-light">
                    EXPERIÈNCIA
                  </span>

                  <strong className="xp-value">
                    {xp.toLocaleString('ca-ES')}
                    <span> XP</span>
                  </strong>

                </div>


                <div className="xp-level">

                  <span>
                    NIVELL ACTUAL
                  </span>

                  <strong>
                    {obtenerNivel()}
                  </strong>

                </div>

              </div>


              <div className="xp-progress-wrapper">

                <div className="xp-progress-background">

                  <div
                    className="xp-progress-fill"
                    style={{
                      width: `${(obtenerXpNivelActual() / 200) * 100}%`,
                    }}
                  />

                </div>

              </div>


              <div className="xp-hero-bottom">

                <span>
                  {obtenerXpNivelActual()} / 200 XP
                </span>

                <span>
                  {200 - obtenerXpNivelActual() === 0
                    ? 'Nivell completat'
                    : `${200 - obtenerXpNivelActual()} XP fins al següent nivell`}
                </span>

              </div>

            </div>


            <div style={ESTILO_TARJETA}>

              <span className="eyebrow">
                📚 EL TEU PROGRÉS
              </span>

              <div style={{ marginTop: '16px' }}>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: '6px',
                  }}
                >
                  <strong>Progrés general</strong>
                  <strong>{estadisticas.porcentajeAcierto}%</strong>
                </div>

                <BarraProgreso porcentaje={estadisticas.porcentajeAcierto} />

              </div>

              {resumenAsignaturas
                .filter((asignatura) => asignatura.respuestas > 0)
                .map((asignatura) => (
                  <div key={asignatura.nombre} style={{ marginTop: '16px' }}>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        marginBottom: '6px',
                      }}
                    >
                      <span>{asignatura.nombre}</span>
                      <strong>{asignatura.porcentaje}%</strong>
                    </div>

                    <BarraProgreso porcentaje={asignatura.porcentaje} />

                  </div>
                ))}

              {resumenAsignaturas.every(
                (asignatura) => asignatura.respuestas === 0,
              ) && (
                <p style={{ marginTop: '16px', color: '#9a9ab0' }}>
                  Encara no has respost cap exercici.
                </p>
              )}

            </div>


            <div className="recommendation-card">

              <div className="recommendation-number">
                01
              </div>

              <div className="recommendation-content">

                <span className="eyebrow">
                  RECOMANACIÓ
                </span>

                <h2>
                  {recomendacionIA ||
                    'El teu espai encara està aprenent sobre tu.'}
                </h2>

                <p>
                  {recomendacionIA
                    ? 'Aquesta recomanació s’ha generat a partir dels teus resultats.'
                    : 'Quan comencis a fer exercicis, l’aplicació detectarà els conceptes que necessites reforçar i et proposarà activitats personalitzades.'}
                </p>

              </div>

              <span className="recommendation-symbol">
                ✦
              </span>

            </div>


            <div style={ESTILO_TARJETA}>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '8px',
                }}
              >
                <span className="eyebrow">
                  🎯 OBJECTIU D'AVUI
                </span>

                <strong>
                  🔥 Ratxa: {rachaDias} {rachaDias === 1 ? 'dia' : 'dies'}
                </strong>
              </div>

              {[
                {
                  etiqueta: 'Exercicis',
                  actual: objetivoHoy.ejercicios,
                  meta: OBJETIVO_DIARIO_EJERCICIOS,
                },
                {
                  etiqueta: 'XP',
                  actual: objetivoHoy.xp,
                  meta: OBJETIVO_DIARIO_XP,
                },
              ].map((barra) => (
                <div key={barra.etiqueta} style={{ marginTop: '16px' }}>

                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '6px',
                    }}
                  >
                    <span>{barra.etiqueta}</span>

                    <strong>
                      {Math.min(barra.actual, barra.meta)} / {barra.meta}
                    </strong>
                  </div>

                  <BarraProgreso
                    porcentaje={(barra.actual / barra.meta) * 100}
                  />

                </div>
              ))}

              {objetivoHoy.ejercicios >= OBJETIVO_DIARIO_EJERCICIOS &&
                objetivoHoy.xp >= OBJETIVO_DIARIO_XP && (
                  <p style={{ marginTop: '16px', fontWeight: 600 }}>
                    🎉 Objectiu d'avui complert!
                  </p>
                )}

            </div>


            <div style={ESTILO_TARJETA}>

              <span className="eyebrow">
                ⚠️ NECESSITES REPASSAR
              </span>

              {problemasRecurrentes.length === 0 &&
              erroresRepaso.length === 0 &&
              estadoTarjetas.hoy === 0 ? (
                <p style={{ marginTop: '12px' }}>
                  Tot al dia! No tens res pendent de repassar. 🎉
                </p>
              ) : (
                <div style={{ display: 'grid', gap: '12px', marginTop: '12px' }}>

                  {problemasRecurrentes.map((tema) => (
                    <div
                      key={tema.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '12px',
                        flexWrap: 'wrap',
                      }}
                    >

                      <div>
                        <strong>{tema.nombre}</strong>
                        <br />
                        <small style={{ color: '#9a9ab0' }}>
                          {tema.asignatura} · {tema.fallos} errors en les
                          últimes {tema.total} respostes
                        </small>
                      </div>

                      <button
                        className="app-button app-button-primary"
                        type="button"
                        disabled={generandoRefuerzo !== null}
                        onClick={() => practicarTemaDebil(tema.id)}
                      >
                        {generandoRefuerzo === tema.id
                          ? 'Generant...'
                          : '🎯 Practicar'}
                      </button>

                    </div>
                  ))}

                  {erroresRepaso.length > 0 && (
                    <button
                      className="app-button app-button-secondary"
                      type="button"
                      onClick={() => setPantalla('repaso')}
                    >
                      🔴 Repassar els meus errors ({erroresRepaso.length})
                    </button>
                  )}

                  {estadoTarjetas.hoy > 0 && (
                    <button
                      className="app-button app-button-secondary"
                      type="button"
                      onClick={() => setPantalla('flashcards')}
                    >
                      🎴 {estadoTarjetas.hoy} targetes per repassar avui
                    </button>
                  )}

                </div>
              )}

            </div>


            {proximoContenido && (
              <div style={ESTILO_TARJETA}>

                <span className="eyebrow">
                  ▶ SEGÜENT CONTINGUT RECOMANAT
                </span>

                <h3 style={{ margin: '8px 0 4px' }}>
                  {proximoContenido.nombre}
                </h3>

                <p style={{ color: '#9a9ab0', marginBottom: '16px' }}>
                  {proximoContenido.asignatura} · {proximoContenido.motivo}
                </p>

                <button
                  className="app-button app-button-primary"
                  type="button"
                  onClick={() => abrirTemaPendiente(proximoContenido.id)}
                >
                  Continuar amb aquest tema →
                </button>

              </div>
            )}


            <div style={ESTILO_TARJETA}>

              <span className="eyebrow">
                🤖 LA TEVA IA
              </span>

              <h3 style={{ margin: '8px 0 16px' }}>
                Què vols estudiar avui?
              </h3>

              <div
                style={{
                  display: 'flex',
                  gap: '8px',
                  flexWrap: 'wrap',
                  marginBottom: '16px',
                }}
              >

                {[
                  'Què hauria de repassar avui?',
                  "Explica'm el meu pitjor tema",
                  "Fes-me un pla d'estudi per avui",
                ].map((pregunta) => (
                  <button
                    key={pregunta}
                    className="app-button app-button-secondary"
                    type="button"
                    onClick={() => {
                      setPantalla('ia')
                      enviarMensajeChat(pregunta)
                    }}
                  >
                    {pregunta}
                  </button>
                ))}

              </div>

              <div style={{ display: 'flex', gap: '12px' }}>

                <input
                  type="text"
                  value={preguntaRapida}
                  placeholder="Pregunta alguna cosa a la IA..."
                  onChange={(event) => setPreguntaRapida(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && preguntaRapida.trim()) {
                      const pregunta = preguntaRapida

                      setPreguntaRapida('')
                      setPantalla('ia')
                      enviarMensajeChat(pregunta)
                    }
                  }}
                  style={{
                    flex: 1,
                    padding: '12px',
                    borderRadius: '12px',
                    border: '1px solid #e0e0ee',
                    fontSize: '15px',
                  }}
                />

                <button
                  className="app-button app-button-primary"
                  type="button"
                  disabled={preguntaRapida.trim() === ''}
                  onClick={() => {
                    const pregunta = preguntaRapida

                    setPreguntaRapida('')
                    setPantalla('ia')
                    enviarMensajeChat(pregunta)
                  }}
                >
                  Preguntar
                </button>

              </div>

            </div>


            <div className="dashboard-section">

              <div className="dashboard-section-heading">

                <div>

                  <span className="eyebrow">
                    CONTINUA
                  </span>

                  <h2>
                    Temes pendents
                  </h2>

                </div>

                <span className="section-count">
                  {temasPendientes.length}
                </span>

              </div>


              {cargandoPendientes && (
                <div className="minimal-state">
                  <span>⏳</span>
                  Carregant temes...
                </div>
              )}


              {!cargandoPendientes &&
                temasPendientes.length === 0 && (
                  <div className="minimal-state">
                    <span>✓</span>
                    No tens temes pendents.
                  </div>
                )}


              {!cargandoPendientes &&
                temasPendientes.length > 0 && (
                  <div className="pending-list">

                    {temasPendientes.map(
                      (tema, index) => (
                        <button
                          className="pending-item"
                          key={tema.id}
                          type="button"
                          onClick={() =>
                            abrirTemaPendiente(
                              tema.id,
                            )
                          }
                        >

                          <span className="pending-index">
                            {String(index + 1).padStart(2, '0')}
                          </span>

                          <div className="pending-info">

                            <span className="pending-subject">
                              {tema.asignatura}
                            </span>

                            <strong>
                              {tema.nombre}
                            </strong>

                            <small>
                              Continuar con el tema
                            </small>

                          </div>

                          <span className="pending-arrow">
                            →
                          </span>

                        </button>
                      ),
                    )}

                  </div>
                )}

            </div>


            <button
              className="app-button app-button-primary"
              type="button"
              onClick={() => setPantalla('estudio')}
              style={{ width: '100%' }}
            >
              📚 Mode estudi
            </button>

                
            <button
              className="app-button app-button-secondary"
              type="button"
              onClick={() => setPantalla('logros')}
              style={{ width: '100%' }}
            >
              🏆 Assoliments ({emojisDesbloqueados.length}/{totalNiveles})
            </button>

          </section>
        )}


        {pantalla === 'assignatures' && (
          <section className="page-section subjects-page">

            <div className="page-heading">

              <div>

                <span className="eyebrow">
                  EL TEU CURS
                </span>

                <h1>
                  Assignatures
                </h1>

                <p>
                  Accedeix als continguts i materials
                  de cada assignatura.
                </p>

              </div>  

              <span className="page-heading-index">
                01
              </span>

            </div>
            
            <div
  style={{
    padding: '20px',
    marginBottom: '20px',
    background: '#ffffff',
    borderRadius: '12px',
  }}
>

  {recomendaciones.map((recomendacion) => (
    <p key={recomendacion.nombre}>
      Repasa <strong>{recomendacion.nombre}</strong> —{' '}
      {recomendacion.errores} error
      {recomendacion.errores !== 1 ? 'es' : ''}
    </p>
  ))}
</div>
          
            <div className="subjects-wrapper">
              <SubjectList
                setAsignaturaSeleccionada={
                  entrarEnAsignatura
                }
                setPantalla={
                  setPantalla
                }
              />
            </div>

          </section>
        )}


        {pantalla === 'assignatura' &&
          asignaturaSeleccionada && (
            <section className="page-section subject-detail-page">

              <button
                className="back-button"
                type="button"
                onClick={volverAAsignaturas}
              >
                <span>←</span>
                Tornar a assignatures
              </button>


              <div className="detail-hero">

                <div>

                  <span className="eyebrow">
                    ASSIGNATURA
                  </span>

                  <h1>
                    {asignaturaSeleccionada}
                  </h1>

                  <p>
                    Organitza i continua el teu
                    estudi per temes.
                  </p>

                </div>

                <span className="detail-hero-number">
                  {temas.length.toString().padStart(2, '0')}
                </span>

              </div>


              <div className="content-panel">

                <div className="content-panel-heading">

                  <div>

                    <span className="eyebrow">
                      CONTINGUT
                    </span>

                    <h2>
                      Temes
                    </h2>

                  </div>

                  {temas.length > 0 && (
                    <span className="section-count">
                      {temas.length}
                    </span>
                  )}

                </div>


                {cargandoTemas && (
                  <div className="minimal-state large">

                    <span>⏳</span>

                    <div>

                      <strong>
                        Carregant temes...
                      </strong>

                      <small>
                        Preparant els continguts
                        de l'assignatura.
                      </small>

                    </div>

                  </div>
                )}


                {errorTemas && (
                  <div className="minimal-state error-state">

                    <span>!</span>

                    <div>

                      <strong>
                        S'ha produït un error
                      </strong>

                      <small>
                        {errorTemas}
                      </small>

                      <button
                        className="app-button app-button-primary"
                        type="button"
                        onClick={() =>
                          asignaturaSeleccionadaId &&
                          cargarTemas(
                            asignaturaSeleccionadaId,
                          )
                        }
                      >
                        Tornar a intentar
                      </button>

                    </div>

                  </div>
                )}


                {!cargandoTemas &&
                  !errorTemas &&
                  temas.length === 0 && (
                    <div className="minimal-state large">

                      <span>✦</span>

                      <div>

                        <strong>
                          Encara no hi ha cap tema
                        </strong>

                        <small>
                          Afegeix el primer tema
                          per començar a organitzar
                          els continguts.
                        </small>

                      </div>

                    </div>
                  )}


                {!cargandoTemas &&
                  !errorTemas &&
                  temas.length > 0 && (
                    <div className="topics-list">

                      {temas.map(
                        (tema, index) => (
                          <article
                            className="topic-card"
                            key={tema.id}
                          >

                            <span className="topic-card-number">
                              {String(index + 1).padStart(2, '0')}
                            </span>

                            <div className="topic-card-content">

                              <div className="topic-card-top">

                                <span className="eyebrow">
                                  TEMA {index + 1}
                                </span>

                                <span className="topic-material-count">
                                  {tema.materials.length} PDF
                                  {tema.materials.length !== 1
                                    ? 's'
                                    : ''}
                                </span>

                              </div>

                              <h3>
                                {tema.name}
                              </h3>

                              <p>
                                Material i exercicis
                                disponibles dins
                                del tema.
                              </p>

                            </div>


                            <div className="topic-card-actions">

                              <button
                                className="topic-open-button"
                                type="button"
                                onClick={() =>
                                  entrarEnTema(
                                    tema,
                                  )
                                }
                              >
                                Obrir
                                <span>↗</span>
                              </button>

                              <button
                                className="icon-button icon-button-danger"
                                type="button"
                                title="Eliminar tema"
                                onClick={() =>
                                  eliminarTema(
                                    tema.id,
                                  )
                                }
                              >
                                ×
                              </button>

                            </div>

                          </article>
                        ),
                      )}

                    </div>
                  )}


                {!mostrarFormularioTema && (
                  <button
                    className="add-topic-button"
                    type="button"
                    onClick={abrirFormularioTema}
                  >
                    <span>
                      +
                    </span>

                    <strong>
                      Afegir tema
                    </strong>

                    <small>
                      Crear nou contingut
                    </small>

                    <b>
                      →
                    </b>
                  </button>
                )}


                {mostrarFormularioTema && (
                  <form
                    className="new-topic-form"
                    onSubmit={crearTema}
                  >

                    <div className="form-heading">

                      <span className="form-number">
                        +
                      </span>

                      <div>

                        <span className="eyebrow">
                          NOU CONTINGUT
                        </span>

                        <h3>
                          Afegir tema
                        </h3>

                      </div>

                    </div>


                    <label htmlFor="nuevo-tema">
                      Nom del tema
                    </label>

                    <input
                      id="nuevo-tema"
                      type="text"
                      value={nombreNuevoTema}
                      onChange={(event) =>
                        setNombreNuevoTema(
                          event.target.value,
                        )
                      }
                      placeholder="Ex: Tema 1 - Introducció"
                      autoFocus
                    />


                    <div className="form-actions">

                      <button
                        className="app-button app-button-primary"
                        type="submit"
                      >
                        Crear tema
                      </button>

                      <button
                        className="app-button app-button-secondary"
                        type="button"
                        onClick={
                          cancelarFormularioTema
                        }
                      >
                        Cancel·lar
                      </button>

                    </div>

                  </form>
                )}

              </div>

            </section>
          )}


        {pantalla === 'tema' &&
          asignaturaSeleccionada &&
          temaSeleccionado && (
            <section className="topic-page">

              <div className="topic-header">

                <button
                  className="topic-back-button"
                  type="button"
                  onClick={() =>
                    setPantalla('assignatura')
                  }
                >
                  <span>←</span>
                  Tornar a l'assignatura
                </button>


                <div className="topic-title-row">

                  <div className="topic-title-content">

                    <span className="eyebrow">
                      TEMA
                    </span>

                    <h1 className="topic-title">
                      {temaSeleccionado.name}
                    </h1>

                  </div>


                  {!editandoNombre && (
                    <button
                      className="topic-edit-button"
                      type="button"
                      onClick={() => {
                        setNombreTemaEditado(
                          temaSeleccionado.name,
                        )

                        setEditandoNombre(true)
                      }}
                    >
                      ✎ Editar nombre
                    </button>
                  )}

                </div>

              </div>


              {editandoNombre && (
                <form
                  className="topic-name-form"
                  onSubmit={guardarNombreTema}
                >

                  <div className="topic-name-form-heading">

                    <span>✎</span>

                    <div>

                      <strong>
                        Editar nom del tema
                      </strong>

                      <small>
                        Actualitza el títol del
                        contingut.
                      </small>

                    </div>

                  </div>


                  <input
                    className="topic-name-input"
                    type="text"
                    value={nombreTemaEditado}
                    onChange={(event) =>
                      setNombreTemaEditado(
                        event.target.value,
                      )
                    }
                    autoFocus
                  />


                  <div className="form-actions">

                    <button
                      className="app-button app-button-primary"
                      type="submit"
                    >
                      Guardar
                    </button>

                    <button
                      className="app-button app-button-secondary"
                      type="button"
                      onClick={() => {
                        setNombreTemaEditado(
                          temaSeleccionado.name,
                        )

                        setEditandoNombre(false)
                      }}
                    >
                      Cancelar
                    </button>

                  </div>

                </form>
              )}


              <section className="topic-section">

                <div className="topic-section-heading">

                  <div>

                    <span className="eyebrow">
                      MATERIAL PRINCIPAL
                    </span>

                    <h2 className="topic-section-title">
                      PDF principal
                    </h2>

                  </div>

                  <span className="section-number">
                    01
                  </span>

                </div>


                {pdfPrincipal ? (
                  <div className="pdf-main-card">

                    <div className="pdf-main-info">

                      <div className="pdf-icon">
                        PDF
                      </div>

                      <div className="pdf-info-text">

                        <strong>
                          {pdfPrincipal.fileName}
                        </strong>

                        <span>
                          Material principal del tema
                        </span>

                      </div>

                    </div>


                    <div className="pdf-actions">

                      <button
                        className="app-button app-button-primary"
                        type="button"
                        onClick={() =>
                          abrirPdf(
                            pdfPrincipal,
                          )
                        }
                      >
                        Obrir PDF
                        <span>↗</span>
                      </button>


                      <label className="app-button app-button-secondary">

                        Canviar PDF

                        <input
                          type="file"
                          accept="application/pdf,.pdf"
                          onChange={
                            cambiarPdfPrincipal
                          }
                          disabled={subiendoPdf}
                          hidden
                        />

                      </label>


                      <button
                        className="app-button app-button-danger"
                        type="button"
                        onClick={() =>
                          eliminarMaterial(
                            pdfPrincipal.id,
                          )
                        }
                      >
                        Eliminar
                      </button>

                    </div>

                  </div>
                ) : (
                  <div className="pdf-upload-card">

                    <div className="pdf-upload-icon">
                      +
                    </div>

                    <div>

                      <strong>
                        Todavía no hay un PDF principal
                      </strong>

                      <p>
                        Añade el material principal
                        de este tema.
                      </p>

                    </div>

                  </div>
                )}

              </section>


              <section className="topic-section">

                <div className="topic-section-heading">

                  <div>

                    <span className="eyebrow">
                      MATERIAL COMPLEMENTARI
                    </span>

                    <h2 className="topic-section-title">
                      PDFs adicionales
                    </h2>

                  </div>

                  <span className="section-number">
                    02
                  </span>

                </div>


                {pdfsAdicionales.length === 0 ? (
                  <div className="pdf-upload-card">

                    <div className="pdf-upload-icon">
                      +
                    </div>

                    <div>

                      <strong>
                        No hay PDFs adicionales
                      </strong>

                      <p>
                        Puedes añadir apuntes,
                        ejercicios o material
                        complementario.
                      </p>

                    </div>

                  </div>
                ) : (
                  <div className="pdf-list">

                    {pdfsAdicionales.map(
                      (material) => (
                        <article
                          className="pdf-item"
                          key={material.id}
                        >

                          <div className="pdf-item-info">

                            <div className="pdf-item-icon">
                              PDF
                            </div>

                            <div className="pdf-item-name-wrapper">

                              <span className="pdf-item-name">
                                {material.fileName}
                              </span>

                              <small>
                                Material complementari
                              </small>

                            </div>

                          </div>


                          <div className="pdf-item-actions">

                            <button
                              className="app-button app-button-primary"
                              type="button"
                              onClick={() =>
                                abrirPdf(
                                  material,
                                )
                              }
                            >
                              Obrir
                            </button>

{material.tipo === 'adicional' && (
  <>
    <button
      className="app-button app-button-primary"
      type="button"
      onClick={() =>
        generarEjerciciosAdicional(
          material,
        )
      }

      disabled={generandoEjercicios === material.id}

    >
      {generandoEjercicios === material.id ? (
  <>
    <span className="spinner" />
    Generando ejercicios...
  </>
) : (
  'Generar ejercicios'
)}
    </button>

    <button
      className="app-button"
      type="button"
      onClick={async () => {
  setMaterialPdfSeleccionado(
    material.path,
  )

  await cargarEjerciciosPdf(material.id)

  setPantalla('ejercicios')
}}
    >
      Ver ejercicios
    </button>
  </>
)}
                            <button
                              className="app-button app-button-danger"
                              type="button"
                              onClick={() =>
                                eliminarMaterial(
                                  material.id,
                                )
                              }
                            >
                              Eliminar
                            </button>

                          </div>

                        </article>
                      ),
                    )}

                  </div>
                )}

              </section>


              <section className="topic-section">

                <div className="topic-section-heading">

                  <div>

                    <span className="eyebrow">
                      BIBLIOTECA
                    </span>

                    <h2 className="topic-section-title">
                      Afegir PDFs
                    </h2>

                  </div>

                  <span className="section-number">
                    03
                  </span>

                </div>


                <div className="pdf-upload-card pdf-upload-card-large">

                  <div className="pdf-upload-icon">
                    ↑
                  </div>

                  <div className="pdf-upload-content">

                    <strong>
                      Añadir material al tema
                    </strong>

                    <p>
                      Puedes seleccionar uno o
                      varios archivos PDF.
                    </p>

                    <label className="pdf-upload-label">

                      Seleccionar PDFs

                      <input
                        type="file"
                        accept="application/pdf,.pdf"
                        multiple
                        onChange={añadirPdf}
                        disabled={subiendoPdf}
                        hidden
                      />

                    </label>


                    {subiendoPdf && (
                      <div className="upload-progress">

                        <span className="upload-spinner">
                          ⟳
                        </span>

                       <span>
  {generandoPrincipal
    ? 'Generando ejercicios...'
    : 'Subiendo PDF...'}
</span>

                      </div>
                    )}

                  </div>

                </div>

              </section>


              <section className="topic-section">

                <div className="topic-ai-card">

                  <div className="topic-ai-icon">
                    ✦
                  </div>

                  <div className="topic-ai-content">

                    <span className="eyebrow">
                      INTEL·LIGÈNCIA ARTIFICIAL
                    </span>

                    <h2 className="topic-section-title">
                      IA del tema
                    </h2>

                    <p>
                      Puedes volver a analizar el
                      material de este tema con
                      la IA local.
                    </p>

                    <button
                      className="app-button app-button-primary"
                      type="button"
                      onClick={reanalizarConIA}
                    >
                      Reanalizar amb IA
                      <span>↗</span>
                    </button>
                    
                    <div
                      style={{
                        display: 'flex',
                        gap: '12px',
                        flexWrap: 'wrap',
                        marginTop: '12px',
                      }}
                    >

                      <button
                        className="app-button app-button-secondary"
                        type="button"
                        onClick={() => {
                          setTemaApuntesId(temaSeleccionado.id)
                          setPantalla('apuntes')
                        }}
                      >
                        📝 Apunts del tema
                      </button>

                      <button
                        className="app-button app-button-secondary"
                        type="button"
                        onClick={() => {
                          setTemaPlanId(temaSeleccionado.id)
                          setPantalla('plan')
                        }}
                      >
                        📅 Pla d'estudi
                      </button>

                    </div>
                  </div>

                </div>

              </section>


              <section className="topic-section exercises-section">

                <div className="topic-section-heading">

                  <div>

                    <span className="eyebrow">
                      PRÀCTICA
                    </span>

                    <h2 className="topic-section-title">
                      Exercicis
                    </h2>

                  </div>

                  <span className="section-number">
                    04
                  </span>

                </div>

                {materialPdfSeleccionado && (
  <div style={{ marginBottom: '20px' }}>
    <strong>
      Exercicis del PDF addicional
    </strong>
  </div>
)}

                {ejercicios.length === 0 && (
                  <div className="pdf-upload-card">

                    <div className="pdf-upload-icon">
                      +
                    </div>

                    <div>

                      <strong>
                        Encara no hi ha exercicis
                      </strong>

                      <p>
                        En aquest tema encara no hi
                        ha exercicis disponibles.
                      </p>

                    </div>

                  </div>
                )}


                {ejercicios.length > 0 && (
                  <div className="exercise-list">

                    {ejercicios.map(
                      (ejercicio, index) => (
                        <article
                          className="exercise-card"
                          key={ejercicio.id}
                        >

                          <div className="exercise-card-header">

                            <div className="exercise-heading">

                              <span className="exercise-number">
                                EXERCICI {String(index + 1).padStart(2, '0')}
                              </span>

                              <h3 className="exercise-title">
                                {ejercicio.titulo}
                              </h3>

                            </div>

                            <span className="exercise-xp">
                              +{ejercicio.xp} XP
                            </span>

                          </div>


                          <div className="exercise-question-box">

                            <span className="exercise-question-label">
                              ENUNCIAT
                            </span>

                            <p className="exercise-question">
                              {ejercicio.enunciado}
                            </p>

                          </div>


                          <div className="exercise-answer-area">

                            <label className="exercise-answer-label">
                              LA TEVA RESPOSTA
                            </label>

                            <textarea
                              className="exercise-textarea"
                              placeholder="Escriu aquí la teva resposta..."
                              rows={5}
                              value={
                                respuestas[
                                  ejercicio.id
                                ] ?? ''
                              }
                              onChange={(event) =>
                                setRespuestas({
                                  ...respuestas,
                                  [ejercicio.id]:
                                    event.target.value,
                                })
                              }
                            />

                              <BotonDictado
                              idioma={idiomaDictado}
                              onIdioma={setIdiomaDictado}
                              idiomas={IDIOMAS_DICTADO}
                              onTexto={(texto) =>
                                setRespuestas((actuales) => ({
                                  ...actuales,
                                  [ejercicio.id]: (
                                    (actuales[ejercicio.id] ?? '') +
                                    ' ' +
                                    texto
                                  ).trim(),
                                }))
                              }
                            />

                          </div>


                                                    <div className="exercise-footer">

                            <div className="exercise-meta">

                              <span>
                                Dificultat
                              </span>

                              <strong>
                                {ejercicio.dificultad}
                              </strong>

                            </div>


                            {!intentosAgotados(ejercicio.id) && (
                              <button
                                className="exercise-submit"
                                type="button"
                                onClick={async () => {
                                  const respuesta =
                                    respuestas[
                                      ejercicio.id
                                    ]?.trim()

                                  if (!respuesta) {
                                    window.alert(
                                      'Escriu una resposta abans de corregir.',
                                    )

                                    return
                                  }

                                  await corregirRespuesta(
                                    ejercicio.id,
                                    respuesta,
                                  )

                                  await cargarUltimaRespuesta(
                                    ejercicio.id,
                                  )
                                }}
                              >
                                Corregir resposta
                                <span>↗</span>
                              </button>
                            )}

                          </div>


                          {correcciones[ejercicio.id] && (
                            <div
                              className={`correction-result ${
                                correcciones[ejercicio.id].correcta
                                  ? 'correct'
                                  : 'incorrect'
                              }`}
                            >

                              <div className="correction-header">

                                <span className="correction-icon">
                                  {correcciones[ejercicio.id].correcta
                                    ? '✓'
                                    : '×'}
                                </span>

                                <p className="correction-status">
                                  {correcciones[ejercicio.id].correcta
                                    ? 'Resposta correcta'
                                    : 'Resposta incorrecta'}
                                </p>

                              </div>


                                {(correcciones[ejercicio.id].correcta ||
                                intentosAgotados(ejercicio.id)) && (
                                <p className="correction-comment">
                                  {correcciones[ejercicio.id].comentario}
                                </p>
                              )}


                              {!correcciones[ejercicio.id].correcta &&
                                correcciones[ejercicio.id].intento < 3 && (
                                  <p>
                                    Intent {correcciones[ejercicio.id].intento} de 3
                                  </p>
                                )}


                              {intentosAgotados(ejercicio.id) && (
                                <>
                                  <div className="correction-solution">
                                    <strong>Solució:</strong>
                                    <p>{correcciones[ejercicio.id].solucion}</p>
                                  </div>

                                  <button
                                    className="app-button app-button-danger"
                                    type="button"
                                    disabled={eliminandoEjercicio === ejercicio.id}
                                    onClick={() => eliminarEjercicio(ejercicio.id)}
                                  >
                                    {eliminandoEjercicio === ejercicio.id
                                      ? 'Generando reemplazo...'
                                      : 'Eliminar ejercicio'}
                                  </button>
                                </>
                              )}

                                                            <button
                                className="app-button app-button-secondary"
                                type="button"
                                onClick={() => reportarCorreccionEjercicio(ejercicio.id)}
                                style={{ marginBottom: '12px' }}
                              >
                                🚩 Reportar correcció errònia
                              </button>

                              <div className="correction-xp">

                                <span>
                                  XP guanyada
                                </span>

                                <strong>
                                  +{correcciones[ejercicio.id].xp_ganada} XP
                                </strong>

                              </div>

                            </div>
                          )}

                        </article>
                      ),
                    )}

                  </div>
                )}

              </section>

            </section>
          )}

        {pantalla === 'ejercicios' && (
          <section className="topic-page">

            <button
              className="app-button"
              type="button"
              onClick={async () => {
  setMaterialPdfSeleccionado(null)
  setPantalla('tema')

  if (temaSeleccionado) {
    await cargarEjercicios(temaSeleccionado.id)
  }
}}
            >
              ← Tornar al tema
            </button>

            <section className="topic-section exercises-section">

              <div className="topic-section-heading">
                <div>
                  <span className="eyebrow">
                    PRÀCTICA
                  </span>

                  <h2 className="topic-section-title">
                    Exercicis
                  </h2>
                </div>
              </div>

              {ejercicios.length === 0 && (
                <div className="pdf-upload-card">
                  <div className="pdf-upload-icon">
                    +
                  </div>

                  <div>
                    <strong>
                      Encara no hi ha exercicis
                    </strong>

                    <p>
                      Aquest PDF encara no té exercicis.
                    </p>
                  </div>
                </div>
              )}

              {ejercicios.length > 0 && (
                <div className="exercise-list">
                  {ejercicios.map(
                    (ejercicio, index) => (
                      <article
                        className="exercise-card"
                        key={ejercicio.id}
                      >

                        <h3>
                          {index + 1}. {ejercicio.titulo}
                        </h3>

                        <p>
                          {ejercicio.enunciado}
                        </p>

                        <textarea
                          value={
                            respuestas[ejercicio.id] ?? ''
                          }
                          onChange={(e) =>
                            setRespuestas({
                              ...respuestas,
                              [ejercicio.id]:
                                e.target.value,
                            })
                          }
                          placeholder="Escriu la teva resposta..."
                        />

                        <button
                          className="app-button app-button-primary"
                          type="button"
                          onClick={() =>
                            corregirRespuesta(
                              ejercicio.id,
                              respuestas[ejercicio.id] ?? '',
                            )
                          }
                          disabled={corrigiendoRespuesta === ejercicio.id}
                        >
                          {corrigiendoRespuesta === ejercicio.id ? (
  <>
    <span className="spinner" />
    Corrigiendo respuesta...
  </>
) : (
  'Corregir respuesta'
)} 
                        </button>

                                               {!intentosAgotados(ejercicio.id) && (
                          <button
                            className="app-button app-button-primary"
                            type="button"
                            onClick={async () => {
                              const respuesta =
                                respuestas[ejercicio.id]?.trim()

                              if (!respuesta) {
                                window.alert(
                                  'Escriu una resposta abans de corregir.',
                                )

                                return
                              }

                              await corregirRespuesta(
                                ejercicio.id,
                                respuesta,
                              )
                            }}
                            disabled={corrigiendoRespuesta === ejercicio.id}
                          >
                            {corrigiendoRespuesta === ejercicio.id ? (
                              <>
                                <span className="spinner" />
                                Corrigiendo respuesta...
                              </>
                            ) : (
                              'Corregir respuesta'
                            )}
                          </button>
                        )}

                        {correcciones[ejercicio.id] && (
                          <div
                            className={`correction-result ${
                              correcciones[ejercicio.id].correcta
                                ? 'correct'
                                : 'incorrect'
                            }`}
                          >

                            <p className="correction-status">
                              {correcciones[ejercicio.id].correcta
                                ? 'Resposta correcta'
                                : 'Resposta incorrecta'}
                            </p>

                            <p className="correction-comment">
                              {correcciones[ejercicio.id].comentario}
                            </p>

                            {!correcciones[ejercicio.id].correcta &&
                              correcciones[ejercicio.id].intento < 3 && (
                                <p>
                                  Intent {correcciones[ejercicio.id].intento} de 3
                                </p>
                              )}

                            {intentosAgotados(ejercicio.id) && (
                              <>
                                <div className="correction-solution">
                                  <strong>Solució:</strong>
                                  <p>{correcciones[ejercicio.id].solucion}</p>
                                </div>

                                <button
                                  className="app-button app-button-danger"
                                  type="button"
                                  disabled={eliminandoEjercicio === ejercicio.id}
                                  onClick={() => eliminarEjercicio(ejercicio.id)}
                                >
                                  {eliminandoEjercicio === ejercicio.id
                                    ? 'Generando reemplazo...'
                                    : 'Eliminar ejercicio'}
                                </button>
                              </>
                            )}

                            <div className="correction-xp">
                              <span>
                                XP guanyada
                              </span>

                              <strong>
                                +{correcciones[ejercicio.id].xp_ganada} XP
                              </strong>
                            </div>

                          </div>
                        )}

                      </article>
                    ),
                  )}
                </div>
              )}

            </section>
          </section>
        )}

                {pantalla === 'repaso' && (
          <section className="page-section">

            <button
              className="back-button"
              type="button"
              onClick={() => setPantalla('inicio')}
            >
              <span>←</span>
              Tornar a l'inici
            </button>


            <div className="page-heading">

              <div>

                <span className="eyebrow">
                  REPÀS
                </span>

                <h1>
                  Repassar els meus errors
                </h1>

                <p>
                  Exercicis que has fallat i encara no has superat.
                </p>

              </div>

              <span className="page-heading-index">
                {String(erroresRepaso.length).padStart(2, '0')}
              </span>

            </div>


            {erroresRepaso.length === 0 && (
              <div className="minimal-state large">

                <span>✓</span>

                <div>

                  <strong>
                    No tens errors pendents
                  </strong>

                  <small>
                    Quan falis un exercici apareixerà aquí.
                  </small>

                </div>

              </div>
            )}


            <div style={{ display: 'grid', gap: '16px' }}>

              {erroresRepaso.map((item) => (
                <article
                  key={item.clave}
                  style={{
                    background: '#ffffff',
                    borderRadius: '20px',
                    padding: '24px',
                    boxShadow: '0 8px 30px rgba(109, 93, 252, 0.08)',
                  }}
                >

                  <span className="eyebrow">
                    {item.asignatura} · {item.temaNombre}
                  </span>

                  <h3 style={{ margin: '8px 0', color: '#e5646e' }}>
                    ❌ Has fallat {item.fallos}{' '}
                    {item.fallos === 1 ? 'vegada' : 'vegades'}
                  </h3>

                  <p style={{ marginBottom: '16px' }}>
                    {item.enunciado}
                  </p>


                  {repasoActivo?.clave !== item.clave && (
                    <button
                      className="app-button app-button-primary"
                      type="button"
                      disabled={repasoActivo?.cargando === true}
                      onClick={() => repasarError(item)}
                    >
                      Repassar
                    </button>
                  )}


                  {repasoActivo?.clave === item.clave && (
                    <div>

                      {repasoActivo.cargando ? (
                        <p>
                          Preparant l'explicació...
                        </p>
                      ) : (
                        <>

                          <div
                            style={{
                              background: '#f5f3ff',
                              borderRadius: '16px',
                              padding: '16px',
                              whiteSpace: 'pre-wrap',
                              lineHeight: 1.6,
                              marginBottom: '16px',
                            }}
                          >
                            {repasoActivo.explicacion}
                          </div>

                          <div
                            style={{
                              display: 'flex',
                              gap: '12px',
                              flexWrap: 'wrap',
                            }}
                          >

                            <button
                              className="app-button app-button-primary"
                              type="button"
                              disabled={generandoPractica !== null}
                              onClick={() => practicarError(item)}
                            >
                              {generandoPractica === item.clave
                                ? 'Generant exercicis...'
                                : '🎯 Practicar-ho'}
                            </button>

                            <button
                              className="app-button app-button-secondary"
                              type="button"
                              onClick={() => marcarErrorRepasado(item)}
                            >
                              ✓ Ja ho entenc
                            </button>

                          </div>

                        </>
                      )}

                    </div>
                  )}

                </article>
              ))}

            </div>

          </section>
        )}

                {pantalla === 'apuntes' && (
          <section className="page-section">

            <button
              className="back-button"
              type="button"
              onClick={() => setPantalla('estudio')}
            >
              <span>←</span>
              Tornar al mode estudi
            </button>

            <div className="page-heading">
              <div>
                <span className="eyebrow">RESUM</span>
                <h1>Apunts</h1>
                <p>
                  La IA resumeix els PDFs del tema en apunts que pots editar i
                  descarregar en PDF.
                </p>
              </div>
              <span className="page-heading-index">📝</span>
            </div>

            <div style={ESTILO_TARJETA}>

              <label
                htmlFor="tema-apuntes"
                style={{ display: 'block', marginBottom: '8px', fontWeight: 600 }}
              >
                Tema
              </label>

              <select
                id="tema-apuntes"
                value={temaApuntesId ?? ''}
                disabled={generandoApuntes}
                onChange={(event) =>
                  setTemaApuntesId(
                    event.target.value ? Number(event.target.value) : null,
                  )
                }
                style={ESTILO_SELECT}
              >
                <option value="">Tria un tema...</option>

                {progresoTemas.map((tema) => (
                  <option key={tema.id} value={tema.id}>
                    {tema.asignatura} · {tema.nombre}
                  </option>
                ))}
              </select>

              {temaApuntesId && (
                <div
                  style={{
                    display: 'flex',
                    gap: '8px',
                    flexWrap: 'wrap',
                    marginTop: '16px',
                  }}
                >

                  <button
                    className="app-button app-button-primary"
                    type="button"
                    disabled={generandoApuntes}
                    onClick={generarApuntes}
                  >
                    {generandoApuntes
                      ? progresoApuntes.total > 0
                        ? `Apuntant ${progresoApuntes.actual}/${progresoApuntes.total}...`
                        : 'Preparant...'
                      : apuntes
                        ? '🔄 Tornar a generar'
                        : '🤖 Generar apunts'}
                  </button>

                  {apuntes && !generandoApuntes && (
                    <>
                      <button
                        className="app-button app-button-secondary"
                        type="button"
                        onClick={() => {
                          setBorradorApuntes(apuntes.contenido)
                          setEditandoApuntes(true)
                        }}
                      >
                        ✎ Editar
                      </button>

                      <button
                        className="app-button app-button-secondary"
                        type="button"
                        onClick={descargarApuntesPdf}
                      >
                        ⬇️ Descarregar PDF
                      </button>

                      <button
                        className="app-button app-button-secondary"
                        type="button"
                        onClick={anadirApuntesComoPdf}
                      >
                        📎 Afegir als PDFs del tema
                      </button>

                      <button
                        className="app-button app-button-danger"
                        type="button"
                        onClick={borrarApuntes}
                      >
                        Esborrar
                      </button>
                    </>
                  )}

                </div>
              )}

              {generandoApuntes && (
                <small
                  style={{ display: 'block', marginTop: '12px', color: '#9a9ab0' }}
                >
                  Tarda uns minuts: la IA resumeix el tema per parts. No tanquis
                  aquesta pantalla.
                </small>
              )}

            </div>

            {temaApuntesId && apuntes && (
              <div style={{ ...ESTILO_TARJETA, marginTop: '16px' }}>

                {editandoApuntes ? (
                  <>
                    <textarea
                      className="exercise-textarea"
                      rows={18}
                      value={borradorApuntes}
                      onChange={(event) => setBorradorApuntes(event.target.value)}
                    />

                    <small
                      style={{ display: 'block', margin: '8px 0', color: '#9a9ab0' }}
                    >
                      Els títols comencen per "## " i els punts per "- ".
                    </small>

                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>

                      <button
                        className="app-button app-button-primary"
                        type="button"
                        onClick={guardarEdicionApuntes}
                      >
                        Guardar
                      </button>

                      <button
                        className="app-button app-button-secondary"
                        type="button"
                        onClick={() => setEditandoApuntes(false)}
                      >
                        Cancel·lar
                      </button>

                    </div>
                  </>
                ) : (
                  <>
                    {apuntes.contenido.split('\n').map((linea, indice) => {
                      if (linea.startsWith('## ')) {
                        return (
                          <h3
                            key={indice}
                            style={{ margin: '20px 0 8px', color: '#6d5dfc' }}
                          >
                            {linea.slice(3)}
                          </h3>
                        )
                      }

                      if (linea.startsWith('- ')) {
                        return (
                          <div
                            key={indice}
                            style={{
                              display: 'flex',
                              gap: '8px',
                              margin: '4px 0',
                              lineHeight: 1.5,
                            }}
                          >
                            <span>•</span>
                            <span>{linea.slice(2)}</span>
                          </div>
                        )
                      }

                      if (linea.trim() === '') {
                        return null
                      }

                      return (
                        <p key={indice} style={{ margin: '4px 0', lineHeight: 1.5 }}>
                          {linea}
                        </p>
                      )
                    })}

                    <small
                      style={{ display: 'block', marginTop: '16px', color: '#9a9ab0' }}
                    >
                      Actualitzat:{' '}
                      {new Date(apuntes.actualizado).toLocaleString('ca-ES')}
                    </small>
                  </>
                )}

              </div>
            )}

            {temaApuntesId && !apuntes && !generandoApuntes && (
              <p style={{ marginTop: '16px', color: '#9a9ab0' }}>
                Encara no hi ha apunts d'aquest tema. Pulsa "Generar apunts".
              </p>
            )}

          </section>
        )}


        {pantalla === 'plan' && (
          <section className="page-section">

            <button
              className="back-button"
              type="button"
              onClick={() => setPantalla('estudio')}
            >
              <span>←</span>
              Tornar al mode estudi
            </button>

            <div className="page-heading">
              <div>
                <span className="eyebrow">PLANIFICACIÓ</span>
                <h1>Pla d'estudi</h1>
                <p>
                  Tria un tema i la data de l'examen: es crea un pla dia a dia
                  adaptat al teu progrés.
                </p>
              </div>
              <span className="page-heading-index">📅</span>
            </div>

            <div style={ESTILO_TARJETA}>

              <label
                htmlFor="tema-plan"
                style={{ display: 'block', marginBottom: '8px', fontWeight: 600 }}
              >
                Tema
              </label>

              <select
                id="tema-plan"
                value={temaPlanId ?? ''}
                onChange={(event) =>
                  setTemaPlanId(
                    event.target.value ? Number(event.target.value) : null,
                  )
                }
                style={ESTILO_SELECT}
              >
                <option value="">Tria un tema...</option>

                {progresoTemas.map((tema) => (
                  <option key={tema.id} value={tema.id}>
                    {tema.asignatura} · {tema.nombre}
                  </option>
                ))}
              </select>

              <label
                htmlFor="fecha-examen-plan"
                style={{ display: 'block', margin: '16px 0 8px', fontWeight: 600 }}
              >
                Data de l'examen
              </label>

              <input
                id="fecha-examen-plan"
                type="date"
                min={fechaEnDias(0)}
                value={fechaExamenPlan}
                onChange={(event) => setFechaExamenPlan(event.target.value)}
                style={ESTILO_SELECT}
              />

              <div
                style={{
                  display: 'flex',
                  gap: '12px',
                  flexWrap: 'wrap',
                  marginTop: '20px',
                }}
              >

                <button
                  className="app-button app-button-primary"
                  type="button"
                  disabled={generandoPlan || !temaPlanId || !fechaExamenPlan}
                  onClick={generarPlan}
                >
                  {generandoPlan
                    ? 'Generant...'
                    : plan
                      ? '🔄 Regenerar pla'
                      : '📅 Generar pla'}
                </button>

                {plan && (
                  <button
                    className="app-button app-button-danger"
                    type="button"
                    onClick={eliminarPlan}
                  >
                    Esborrar pla
                  </button>
                )}

              </div>

            </div>

            {plan && (
              <>
                <div style={{ ...ESTILO_TARJETA, marginTop: '16px' }}>

                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: '8px',
                      marginBottom: '8px',
                    }}
                  >
                    <strong>
                      {plan.tareas.filter((tarea) => tarea.hecho).length} /{' '}
                      {plan.tareas.length} tasques fetes
                    </strong>

                    <span style={{ color: '#9a9ab0' }}>
                      {Math.max(0, diasEntre(fechaEnDias(0), plan.fechaExamen))}{' '}
                      dies per a l'examen
                    </span>
                  </div>

                  <BarraProgreso
                    porcentaje={
                      plan.tareas.length === 0
                        ? 0
                        : (plan.tareas.filter((tarea) => tarea.hecho).length /
                            plan.tareas.length) *
                          100
                    }
                  />

                  <button
                    className="app-button app-button-secondary"
                    type="button"
                    onClick={() => setSoloSemana(!soloSemana)}
                    style={{ marginTop: '16px' }}
                  >
                    {soloSemana ? 'Veure tot el pla' : 'Veure només aquesta setmana'}
                  </button>

                </div>

                <div style={{ display: 'grid', gap: '16px', marginTop: '16px' }}>

                  {agruparPorDia(plan.tareas)
                    .filter((dia) => {
                      if (!soloSemana) {
                        return true
                      }

                      const hoy = fechaEnDias(0)

                      return (
                        (dia.fecha >= hoy && diasEntre(hoy, dia.fecha) <= 6) ||
                        (dia.fecha < hoy && dia.tareas.some((tarea) => !tarea.hecho))
                      )
                    })
                    .map((dia) => {
                      const hoy = fechaEnDias(0)
                      const esHoy = dia.fecha === hoy
                      const esPasado = dia.fecha < hoy

                      return (
                        <article
                          key={dia.fecha}
                          style={{
                            ...ESTILO_TARJETA,
                            padding: '20px',
                            border: esHoy ? '2px solid #6d5dfc' : 'none',
                          }}
                        >

                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              flexWrap: 'wrap',
                              gap: '8px',
                            }}
                          >
                            <strong style={{ textTransform: 'capitalize' }}>
                              {new Date(`${dia.fecha}T00:00:00`).toLocaleDateString(
                                'ca-ES',
                                { weekday: 'long', day: 'numeric', month: 'long' },
                              )}
                            </strong>

                            <span>
                              {esHoy && (
                                <span style={{ color: '#6d5dfc', fontWeight: 700 }}>
                                  AVUI{' '}
                                </span>
                              )}

                              {dia.fecha === plan.fechaExamen && (
                                <span style={{ color: '#e5646e', fontWeight: 700 }}>
                                  📝 EXAMEN
                                </span>
                              )}

                              {esPasado && dia.tareas.some((tarea) => !tarea.hecho) && (
                                <span style={{ color: '#c47a00', fontWeight: 600 }}>
                                  Pendent
                                </span>
                              )}
                            </span>
                          </div>

                          {dia.tareas.map((tarea) => (
                            <div
                              key={tarea.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '12px',
                                marginTop: '12px',
                                flexWrap: 'wrap',
                              }}
                            >

                              <input
                                type="checkbox"
                                checked={tarea.hecho}
                                onChange={() => alternarTareaPlan(tarea.id)}
                                style={{ width: '20px', height: '20px' }}
                              />

                              <span
                                style={{
                                  flex: 1,
                                  minWidth: '160px',
                                  textDecoration: tarea.hecho ? 'line-through' : 'none',
                                  color: tarea.hecho ? '#9a9ab0' : 'inherit',
                                }}
                              >
                                {tarea.texto}
                              </span>

                              {tarea.tipo !== 'descanso' && (
                                <button
                                  className="app-button app-button-secondary"
                                  type="button"
                                  onClick={() => irATarea(tarea)}
                                >
                                  Anar-hi →
                                </button>
                              )}

                            </div>
                          ))}

                        </article>
                      )
                    })}

                </div>
              </>
            )}

            {temaPlanId && !plan && (
              <p style={{ marginTop: '16px', color: '#9a9ab0' }}>
                Aquest tema encara no té pla. Tria la data de l'examen i pulsa
                "Generar pla".
              </p>
            )}

          </section>
        )}

                {pantalla === 'visor' && materialVisor && (
          <section className="page-section">

            <button
              className="back-button"
              type="button"
              onClick={() => setPantalla('tema')}
            >
              <span>←</span>
              Tornar al tema
            </button>

            <div className="page-heading">
              <div>
                <span className="eyebrow">VISOR DE PDF</span>
                <h1 style={{ wordBreak: 'break-word' }}>
                  {materialVisor.fileName}
                </h1>
              </div>
              <span className="page-heading-index">📖</span>
            </div>

            <div
              onPointerDown={(evento) => {
                // Los botones no deben borrar el text seleccionat
                if ((evento.target as HTMLElement).closest('button')) {
                  evento.preventDefault()
                }
              }}
            >

              <div
                style={{
                  ...ESTILO_TARJETA,
                  padding: '16px',
                  marginBottom: '16px',
                  display: 'flex',
                  gap: '10px',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >

                <button
                  className="app-button app-button-secondary"
                  type="button"
                  disabled={paginaVisor <= 1}
                  onClick={() => cambiarPaginaVisor(-1)}
                >
                  ◀
                </button>

                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  Pàg.
                  <input
                    type="number"
                    min={1}
                    max={totalPaginasVisor || 1}
                    value={paginaVisor}
                    onChange={(evento) => {
                      const numero = Number(evento.target.value)

                      if (numero >= 1 && numero <= totalPaginasVisor) {
                        setPaginaVisor(numero)
                      }
                    }}
                    style={{
                      width: '64px',
                      padding: '8px',
                      borderRadius: '10px',
                      border: '1px solid #e0e0ee',
                    }}
                  />
                  / {totalPaginasVisor}
                </span>

                <button
                  className="app-button app-button-secondary"
                  type="button"
                  disabled={paginaVisor >= totalPaginasVisor}
                  onClick={() => cambiarPaginaVisor(1)}
                >
                  ▶
                </button>

                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    marginLeft: '8px',
                  }}
                >
                  <button
                    className="app-button app-button-secondary"
                    type="button"
                    disabled={zoomVisor <= 0.5}
                    onClick={() =>
                      setZoomVisor((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))
                    }
                  >
                    −
                  </button>

                  <strong style={{ minWidth: '48px', textAlign: 'center' }}>
                    {Math.round(zoomVisor * 100)}%
                  </strong>

                  <button
                    className="app-button app-button-secondary"
                    type="button"
                    disabled={zoomVisor >= 3}
                    onClick={() =>
                      setZoomVisor((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100))
                    }
                  >
                    +
                  </button>
                </span>

                <button
                  className="app-button app-button-secondary"
                  type="button"
                  onClick={alternarMarcadorVisor}
                >
                  {marcadoresVisor.some((marcador) => marcador.pagina === paginaVisor)
                    ? '🔖 Treure marcador'
                    : '🔖 Marcador'}
                </button>

                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {Object.entries(COLORES_SUBRAYADO).map(([nombre, color]) => (
                    <button
                      key={nombre}
                      type="button"
                      title={nombre}
                      onClick={() => setColorSubrayado(nombre)}
                      style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '50%',
                        background: color,
                        cursor: 'pointer',
                        border:
                          colorSubrayado === nombre
                            ? '3px solid #17171f'
                            : '2px solid #ffffff',
                        boxShadow: '0 0 0 1px #d0d0e0',
                      }}
                    />
                  ))}
                </span>

                <button
                  className="app-button app-button-primary"
                  type="button"
                  onClick={subrayarSeleccion}
                >
                  🖍️ Subratlla
                </button>

                <button
                  className="app-button app-button-secondary"
                  type="button"
                  onClick={() => abrirPdfEnPestana(materialVisor)}
                >
                  ↗ Pestanya nova
                </button>

              </div>

              {cargandoVisor && (
                <p style={{ color: '#9a9ab0', margin: '16px 0' }}>
                  Carregant el PDF...
                </p>
              )}

              {errorVisor && (
                <p style={{ color: '#e5646e', margin: '16px 0' }}>
                  {errorVisor}
                </p>
              )}

              <div
                ref={contenedorVisorRef}
                style={{
                  background: '#e9e9f2',
                  borderRadius: '20px',
                  padding: '8px',
                  overflow: 'auto',
                  maxHeight: '75vh',
                }}
              >

                <div
                  ref={paginaDivVisorRef}
                  style={{
                    position: 'relative',
                    margin: '0 auto',
                    background: '#ffffff',
                    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
                    display: pdfListoVisor ? 'block' : 'none',
                  }}
                >

                  <canvas ref={canvasVisorRef} style={{ display: 'block' }} />

                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      pointerEvents: 'none',
                    }}
                  >
                    {subrayadosVisor
                      .filter((subrayado) => subrayado.pagina === paginaVisor)
                      .flatMap((subrayado) =>
                        subrayado.rects.map((rect, indice) => (
                          <div
                            key={`${subrayado.id}-${indice}`}
                            style={{
                              position: 'absolute',
                              left: `${rect.x * 100}%`,
                              top: `${rect.y * 100}%`,
                              width: `${rect.w * 100}%`,
                              height: `${rect.h * 100}%`,
                              background:
                                COLORES_SUBRAYADO[subrayado.color] ?? '#ffe066',
                              mixBlendMode: 'multiply',
                              opacity: 0.6,
                              borderRadius: '2px',
                            }}
                          />
                        )),
                      )}
                  </div>

                  <div ref={capaTextoVisorRef} className="textLayer" />

                </div>

              </div>

              <div style={{ ...ESTILO_TARJETA, marginTop: '16px' }}>

                <div
                  style={{
                    display: 'flex',
                    gap: '8px',
                    flexWrap: 'wrap',
                    marginBottom: '16px',
                  }}
                >
                  {[
                    { id: 'subrayados', texto: `🖍️ Subratllats (${subrayadosVisor.length})` },
                    { id: 'marcadores', texto: `🔖 Marcadors (${marcadoresVisor.length})` },
                    { id: 'ia', texto: '🤖 IA' },
                  ].map((pestana) => (
                    <button
                      key={pestana.id}
                      className={
                        panelVisor === pestana.id
                          ? 'app-button app-button-primary'
                          : 'app-button app-button-secondary'
                      }
                      type="button"
                      onClick={() =>
                        setPanelVisor(pestana.id as 'subrayados' | 'marcadores' | 'ia')
                      }
                    >
                      {pestana.texto}
                    </button>
                  ))}
                </div>

                {panelVisor === 'subrayados' && (
                  <div>
                    {subrayadosVisor.length === 0 && (
                      <p style={{ color: '#9a9ab0' }}>
                        Encara no has subratllat res. Selecciona text a la
                        pàgina i pulsa "🖍️ Subratlla".
                      </p>
                    )}

                    {[...subrayadosVisor]
                      .sort((a, b) => a.pagina - b.pagina || a.id - b.id)
                      .map((subrayado) => (
                        <div
                          key={subrayado.id}
                          style={{
                            display: 'flex',
                            gap: '10px',
                            alignItems: 'flex-start',
                            padding: '10px 0',
                            borderTop: '1px solid #ececf4',
                          }}
                        >

                          <span
                            style={{
                              width: '12px',
                              height: '12px',
                              borderRadius: '50%',
                              marginTop: '6px',
                              flexShrink: 0,
                              background:
                                COLORES_SUBRAYADO[subrayado.color] ?? '#ffe066',
                            }}
                          />

                          <button
                            type="button"
                            onClick={() => setPaginaVisor(subrayado.pagina)}
                            style={{
                              flex: 1,
                              textAlign: 'left',
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              lineHeight: 1.4,
                            }}
                          >
                            <strong>p. {subrayado.pagina}</strong> · {subrayado.texto}
                          </button>

                          <button
                            className="app-button app-button-danger"
                            type="button"
                            onClick={() => borrarSubrayado(subrayado.id)}
                          >
                            ✕
                          </button>

                        </div>
                      ))}
                  </div>
                )}

                {panelVisor === 'marcadores' && (
                  <div>
                    {marcadoresVisor.length === 0 && (
                      <p style={{ color: '#9a9ab0' }}>
                        Encara no tens marcadors. Pulsa "🔖 Marcador" a la
                        pàgina que vulguis recordar.
                      </p>
                    )}

                    {marcadoresVisor.map((marcador) => (
                      <div
                        key={marcador.id}
                        style={{
                          display: 'flex',
                          gap: '10px',
                          alignItems: 'center',
                          padding: '10px 0',
                          borderTop: '1px solid #ececf4',
                        }}
                      >

                        <button
                          type="button"
                          onClick={() => setPaginaVisor(marcador.pagina)}
                          style={{
                            flex: 1,
                            textAlign: 'left',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          <strong>🔖 Pàgina {marcador.pagina}</strong>
                          {marcador.nota ? ` · ${marcador.nota}` : ''}
                        </button>

                        <button
                          className="app-button app-button-danger"
                          type="button"
                          onClick={() => borrarMarcadorVisor(marcador.id)}
                        >
                          ✕
                        </button>

                      </div>
                    ))}
                  </div>
                )}

                {panelVisor === 'ia' && (
                  <div>

                    <p style={{ color: '#9a9ab0', marginBottom: '12px' }}>
                      La IA llegeix només la pàgina {paginaVisor}. Si has
                      seleccionat text, "Explica'm" parlarà només d'aquest
                      fragment.
                    </p>

                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        flexWrap: 'wrap',
                        marginBottom: '12px',
                      }}
                    >

                      <button
                        className="app-button app-button-primary"
                        type="button"
                        disabled={preguntandoVisor}
                        onClick={() => preguntarIAVisor('explicar')}
                      >
                        🧠 Explica'm
                      </button>

                      <button
                        className="app-button app-button-secondary"
                        type="button"
                        disabled={preguntandoVisor}
                        onClick={() => preguntarIAVisor('resumir')}
                      >
                        📝 Resum de la pàgina
                      </button>

                    </div>

                    <div style={{ display: 'flex', gap: '8px' }}>

                      <input
                        type="text"
                        value={preguntaVisor}
                        placeholder="Pregunta alguna cosa sobre aquesta pàgina..."
                        onChange={(evento) => setPreguntaVisor(evento.target.value)}
                        onKeyDown={(evento) => {
                          if (evento.key === 'Enter' && !preguntandoVisor) {
                            preguntarIAVisor('libre')
                          }
                        }}
                        style={{
                          flex: 1,
                          padding: '12px',
                          borderRadius: '12px',
                          border: '1px solid #e0e0ee',
                          fontSize: '15px',
                        }}
                      />

                      <button
                        className="app-button app-button-primary"
                        type="button"
                        disabled={preguntandoVisor || preguntaVisor.trim() === ''}
                        onClick={() => preguntarIAVisor('libre')}
                      >
                        Preguntar
                      </button>

                    </div>

                    {preguntandoVisor && (
                      <p style={{ marginTop: '16px', color: '#9a9ab0' }}>
                        Pensant...
                      </p>
                    )}

                    {respuestaIAVisor && (
                      <div
                        style={{
                          marginTop: '16px',
                          background: '#f5f3ff',
                          borderRadius: '16px',
                          padding: '16px',
                          whiteSpace: 'pre-wrap',
                          lineHeight: 1.6,
                        }}
                      >
                        {respuestaIAVisor}
                      </div>
                    )}

                  </div>
                )}

              </div>

            </div>

          </section>
        )}

                {pantalla === 'ingles' && (
          <section className="page-section">

            <button
              className="back-button"
              type="button"
              onClick={() => setPantalla('estudio')}
            >
              <span>←</span>
              Tornar al mode estudi
            </button>

            <div className="page-heading">
              <div>
                <span className="eyebrow">IDIOMES</span>
                <h1>Anglès Professional</h1>
                <p>Vocabulari, redaccions i pronunciació, amb veu.</p>
              </div>
              <span className="page-heading-index">🇬🇧</span>
            </div>

            <div
              style={{
                display: 'flex',
                gap: '8px',
                flexWrap: 'wrap',
                marginBottom: '16px',
              }}
            >
              {[
                { id: 'vocabulario', texto: '📚 Vocabulari' },
                { id: 'redaccion', texto: '✍️ Redaccions' },
                { id: 'pronunciacion', texto: '🗣️ Pronunciació' },
              ].map((pestana) => (
                <button
                  key={pestana.id}
                  className={
                    pestanaIngles === pestana.id
                      ? 'app-button app-button-primary'
                      : 'app-button app-button-secondary'
                  }
                  type="button"
                  onClick={() =>
                    setPestanaIngles(
                      pestana.id as 'vocabulario' | 'redaccion' | 'pronunciacion',
                    )
                  }
                >
                  {pestana.texto}
                </button>
              ))}
            </div>

            {pestanaIngles === 'vocabulario' && (
              <div style={ESTILO_TARJETA}>

                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>
                  Tema on guardar les targetes
                </label>

                <select
                  value={temaInglesId ?? ''}
                  onChange={(evento) =>
                    setTemaInglesId(
                      evento.target.value ? Number(evento.target.value) : null,
                    )
                  }
                  style={ESTILO_SELECT}
                >
                  <option value="">Tria un tema...</option>

                  {progresoTemas.map((tema) => (
                    <option key={tema.id} value={tema.id}>
                      {tema.asignatura} · {tema.nombre}
                    </option>
                  ))}
                </select>

                <label style={{ display: 'block', margin: '16px 0 6px', fontWeight: 600 }}>
                  De què vols vocabulari?
                </label>

                <input
                  type="text"
                  value={temaVocabulario}
                  placeholder="Ex: customer service, job interview, advertising campaign"
                  onChange={(evento) => setTemaVocabulario(evento.target.value)}
                  style={ESTILO_SELECT}
                />

                <label style={{ display: 'block', margin: '16px 0 6px', fontWeight: 600 }}>
                  Traducció a
                </label>

                <select
                  value={idiomaTraduccion}
                  onChange={(evento) => setIdiomaTraduccion(evento.target.value)}
                  style={ESTILO_SELECT}
                >
                  <option value="català">Català</option>
                  <option value="español">Español</option>
                </select>

                <button
                  className="app-button app-button-primary"
                  type="button"
                  disabled={generandoVocabulario}
                  onClick={generarVocabulario}
                  style={{ marginTop: '20px' }}
                >
                  {generandoVocabulario ? 'Generant...' : '🤖 Generar 10 paraules'}
                </button>

                {vocabularioNuevo.length > 0 && (
                  <div style={{ marginTop: '20px' }}>

                    <strong>
                      ✅ {vocabularioNuevo.length} targetes noves guardades
                    </strong>

                    {vocabularioNuevo.map((palabra) => (
                      <div
                        key={palabra.termino}
                        style={{
                          display: 'flex',
                          gap: '10px',
                          alignItems: 'flex-start',
                          padding: '10px 0',
                          borderTop: '1px solid #ececf4',
                        }}
                      >

                        <button
                          type="button"
                          title="Escoltar"
                          onClick={() => leerEnVoz(palabra.termino, 'en-US')}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: '20px',
                          }}
                        >
                          🔊
                        </button>

                        <div style={{ lineHeight: 1.4 }}>
                          <strong>{palabra.termino}</strong> — {palabra.traduccion}
                          <br />
                          <small style={{ color: '#9a9ab0' }}>{palabra.ejemplo}</small>
                        </div>

                      </div>
                    ))}

                    <button
                      className="app-button app-button-secondary"
                      type="button"
                      onClick={() => {
                        setTemaFlashId(temaInglesId)
                        setPantalla('flashcards')
                      }}
                      style={{ marginTop: '16px' }}
                    >
                      🎴 Repassar-les a Flashcards
                    </button>

                  </div>
                )}

              </div>
            )}

            {pestanaIngles === 'redaccion' && (
              <div style={ESTILO_TARJETA}>

                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>
                  Tipus de text
                </label>

                <select
                  value={tipoRedaccion}
                  onChange={(evento) => setTipoRedaccion(evento.target.value)}
                  style={ESTILO_SELECT}
                >
                  <option value="email">Email professional</option>
                  <option value="cover letter">Carta de presentació</option>
                  <option value="report">Informe breu</option>
                  <option value="customer message">Missatge a un client</option>
                </select>

                <label style={{ display: 'block', margin: '16px 0 6px', fontWeight: 600 }}>
                  El teu text en anglès
                </label>

                <textarea
                  className="exercise-textarea"
                  rows={8}
                  value={textoRedaccion}
                  placeholder="Write your text here..."
                  onChange={(evento) => setTextoRedaccion(evento.target.value)}
                />

                <div
                  style={{
                    display: 'flex',
                    gap: '12px',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    marginTop: '12px',
                  }}
                >
                  <BotonDictado
                    idioma={idiomaIngles}
                    onIdioma={setIdiomaIngles}
                    idiomas={IDIOMAS_INGLES}
                    onTexto={(texto) =>
                      setTextoRedaccion((actual) =>
                        actual ? `${actual} ${texto}` : texto,
                      )
                    }
                  />

                  <button
                    className="app-button app-button-primary"
                    type="button"
                    disabled={corrigiendoRedaccion}
                    onClick={corregirRedaccion}
                  >
                    {corrigiendoRedaccion ? 'Corregint...' : '✅ Corregir'}
                  </button>
                </div>

                {resultadoRedaccion && (
                  <div style={{ marginTop: '24px' }}>

                    <div style={{ fontSize: '40px', fontWeight: 700, color: '#6d5dfc' }}>
                      {resultadoRedaccion.puntuacion} / 10
                    </div>

                    <span className="eyebrow">TEXT CORREGIT</span>

                    <div
                      style={{
                        background: '#f5f3ff',
                        borderRadius: '16px',
                        padding: '16px',
                        margin: '8px 0 16px',
                        whiteSpace: 'pre-wrap',
                        lineHeight: 1.6,
                      }}
                    >
                      {resultadoRedaccion.texto_corregido}
                    </div>

                    {resultadoRedaccion.errores.length > 0 && (
                      <>
                        <span className="eyebrow">ERRORS</span>

                        {resultadoRedaccion.errores.map((error, indice) => (
                          <div
                            key={indice}
                            style={{
                              padding: '10px 0',
                              borderTop: '1px solid #ececf4',
                              lineHeight: 1.5,
                            }}
                          >
                            <span style={{ color: '#e5646e', textDecoration: 'line-through' }}>
                              {error.original}
                            </span>
                            {' → '}
                            <strong style={{ color: '#2f9e6e' }}>{error.correccion}</strong>
                            <br />
                            <small style={{ color: '#6b6b80' }}>{error.explicacion}</small>
                          </div>
                        ))}
                      </>
                    )}

                    {resultadoRedaccion.consejo && (
                      <p style={{ marginTop: '12px' }}>
                        💡 {resultadoRedaccion.consejo}
                      </p>
                    )}

                    <button
                      className="app-button app-button-secondary"
                      type="button"
                      onClick={() =>
                        guardarReporte({
                          origen: 'redaccion',
                          enunciado: `Tipus: ${tipoRedaccion}`,
                          respuesta: textoRedaccion,
                          solucion: resultadoRedaccion.texto_corregido,
                          comentarioIA: `Nota ${resultadoRedaccion.puntuacion}/10`,
                        })
                      }
                      style={{ marginTop: '12px' }}
                    >
                      🚩 Reportar correcció errònia
                    </button>

                  </div>
                )}

              </div>
            )}

            {pestanaIngles === 'pronunciacion' && (
              <div style={ESTILO_TARJETA}>

                <span className="eyebrow">FRASE MODEL</span>

                <p style={{ fontSize: '22px', lineHeight: 1.5, margin: '8px 0 16px' }}>
                  {resultadoPronunciacion
                    ? resultadoPronunciacion.palabras.map((item, indice) => (
                        <span
                          key={indice}
                          style={{
                            color: item.ok ? '#2f9e6e' : '#e5646e',
                            fontWeight: 600,
                          }}
                        >
                          {item.palabra}{' '}
                        </span>
                      ))
                    : fraseObjetivo}
                </p>

                <div
                  style={{
                    display: 'flex',
                    gap: '12px',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >

                  <button
                    className="app-button app-button-secondary"
                    type="button"
                    onClick={() => leerEnVoz(fraseObjetivo, idiomaIngles)}
                  >
                    🔊 Escoltar model
                  </button>

                  <BotonDictado
                    idioma={idiomaIngles}
                    onIdioma={setIdiomaIngles}
                    idiomas={IDIOMAS_INGLES}
                    onTexto={evaluarPronunciacion}
                  />

                  <button
                    className="app-button app-button-secondary"
                    type="button"
                    onClick={siguienteFrase}
                  >
                    ⏭️ Una altra frase
                  </button>

                </div>

                {resultadoPronunciacion && (
                  <div style={{ marginTop: '20px' }}>

                    <strong
                      style={{
                        fontSize: '32px',
                        color:
                          resultadoPronunciacion.porcentaje >= 80
                            ? '#2f9e6e'
                            : '#e5646e',
                      }}
                    >
                      {resultadoPronunciacion.porcentaje}%
                    </strong>

                    <p style={{ color: '#9a9ab0', marginTop: '4px' }}>
                      En verd, les paraules que has dit bé. En vermell, les que
                      falten o no s'han reconegut. Prova-ho de nou!
                    </p>

                  </div>
                )}

                <small style={{ display: 'block', marginTop: '16px', color: '#9a9ab0' }}>
                  El dictat per veu funciona a Chrome, Edge i Safari, i al mòbil
                  només amb HTTPS.
                </small>

              </div>
            )}

          </section>
        )}

                {pantalla === 'pomodoro' && (
          <section className="page-section">

            <button
              className="back-button"
              type="button"
              onClick={() => setPantalla('estudio')}
            >
              <span>←</span>
              Tornar al mode estudi
            </button>

            <div className="page-heading">
              <div>
                <span className="eyebrow">CONCENTRACIÓ</span>
                <h1>Pomodoro</h1>
                <p>
                  Estudia en blocs de focus amb descansos curts. Cada bloc
                  complet et dona XP.
                </p>
              </div>
              <span className="page-heading-index">🍅</span>
            </div>

            <div style={{ ...ESTILO_TARJETA, textAlign: 'center' }}>

              <span className="eyebrow">
                {pomoFase === 'foco'
                  ? '🍅 FOCUS'
                  : pomoFase === 'descanso'
                    ? '☕ DESCANS'
                    : 'ENDAVANT?'}
              </span>

              <div
                style={{
                  fontSize: '72px',
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  margin: '8px 0 16px',
                  color: pomoFase === 'descanso' ? '#2f9e6e' : '#6d5dfc',
                }}
              >
                {formatoTiempo(
                  pomoFase === 'parado'
                    ? PRESETS_POMODORO[presetPomodoro].foco * 60
                    : pomoRestante,
                )}
              </div>

              {pomoFase !== 'parado' && (
                <div style={{ marginBottom: '20px' }}>
                  <BarraLogro
                    porcentaje={
                      ((pomoDuracionSeg - pomoRestante) / pomoDuracionSeg) * 100
                    }
                  />
                </div>
              )}

              {pomoFase === 'parado' && (
                <select
                  value={presetPomodoro}
                  onChange={(event) =>
                    setPresetPomodoro(
                      event.target.value as keyof typeof PRESETS_POMODORO,
                    )
                  }
                  style={{ ...ESTILO_SELECT, marginBottom: '16px' }}
                >
                  {Object.entries(PRESETS_POMODORO).map(([clave, preset]) => (
                    <option key={clave} value={clave}>
                      {preset.nombre} · +{preset.xp} XP
                    </option>
                  ))}
                </select>
              )}

              <div
                style={{
                  display: 'flex',
                  gap: '12px',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                }}
              >

                {pomoFase === 'parado' ? (
                  <button
                    className="app-button app-button-primary"
                    type="button"
                    onClick={iniciarPomodoro}
                  >
                    ▶ Començar
                  </button>
                ) : (
                  <>
                    <button
                      className="app-button app-button-danger"
                      type="button"
                      onClick={detenerPomodoro}
                    >
                      ■ Aturar
                    </button>

                    {pomoFase === 'descanso' && (
                      <button
                        className="app-button app-button-secondary"
                        type="button"
                        onClick={detenerPomodoro}
                      >
                        Saltar descans
                      </button>
                    )}
                  </>
                )}

              </div>

            </div>

            <div style={{ ...ESTILO_TARJETA, marginTop: '16px' }}>

              <span className="eyebrow">LES TEVES SESSIONS</span>

              <p style={{ margin: '8px 0' }}>
                🍅 Avui: <strong>{resumenPomodoro.hoy}</strong> /{' '}
                {MAX_POMODOROS_XP_DIA} amb XP · Total:{' '}
                <strong>{resumenPomodoro.total}</strong>
              </p>

              <small style={{ color: '#9a9ab0' }}>
                Si aturos abans d'acabar el bloc de focus, no compta ni dona
                XP.
              </small>

            </div>

            <div style={{ ...ESTILO_TARJETA, marginTop: '16px' }}>

              <span className="eyebrow">COM FUNCIONA</span>

              <p style={{ marginTop: '8px', lineHeight: 1.6 }}>
                Treballes un bloc sense distraccions (mòbil lluny!), descanses
                uns minuts i repeteixes. Cada 4 blocs fas un descans llarg.
                Deixa aquesta pestanya oberta: el temps també es veu al títol
                del navegador.
              </p>

            </div>

          </section>
        )}

                {pantalla === 'logros' && (
          <section className="page-section">

            <button
              className="back-button"
              type="button"
              onClick={() => setPantalla('inicio')}
            >
              <span>←</span>
              Tornar a l'inici
            </button>

            <div className="page-heading">
              <div>
                <span className="eyebrow">REPTES</span>
                <h1>Assoliments</h1>
                <p>
                  Cada repte complert en desbloqueja un de més difícil i et
                  dona un emoji per a la teva foto de perfil.
                </p>
              </div>
              <span className="page-heading-index">🏆</span>
            </div>


            <div style={{ ...ESTILO_TARJETA, marginBottom: '16px' }}>

              <span className="eyebrow">EL TEU PERFIL</span>

              <div
                style={{
                  display: 'flex',
                  gap: '24px',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  marginTop: '20px',
                }}
              >

                <div
                  style={{
                    position: 'relative',
                    width: '96px',
                    height: '96px',
                    flexShrink: 0,
                  }}
                >

                  {fotoPerfil ? (
                    <img
                      src={fotoPerfil}
                      alt="Foto de perfil"
                      style={{
                        width: '96px',
                        height: '96px',
                        borderRadius: '50%',
                        objectFit: 'cover',
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: '96px',
                        height: '96px',
                        borderRadius: '50%',
                        background: '#17171f',
                        color: '#ffffff',
                        display: 'grid',
                        placeItems: 'center',
                        fontSize: '32px',
                        fontWeight: 700,
                      }}
                    >
                      K
                    </div>
                  )}

                  {complementos.slice(0, 3).map((emoji, indice) => (
                    <span
                      key={emoji}
                      style={{
                        position: 'absolute',
                        zIndex: 2,
                        fontSize: '28px',
                        lineHeight: 1,
                        pointerEvents: 'none',
                        filter: 'drop-shadow(0 3px 6px rgba(0, 0, 0, 0.25))',
                        ...POSICIONES_COMPLEMENTO[indice],
                      }}
                    >
                      {emoji}
                    </span>
                  ))}

                </div>

                <div style={{ flex: 1, minWidth: '200px' }}>

                  <strong>
                    {complementos.length} / 3 complements
                  </strong>

                  <p style={{ color: '#9a9ab0', marginTop: '4px' }}>
                    Toca un emoji desbloquejat per posar-te'l o treure'l.
                  </p>

                  <small style={{ color: '#6d5dfc', fontWeight: 600 }}>
                    {emojisDesbloqueados.length} / {totalNiveles} emojis desbloquejats
                  </small>

                </div>

              </div>

              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '8px',
                  marginTop: '20px',
                }}
              >

                {emojisDesbloqueados.length === 0 && (
                  <p style={{ color: '#9a9ab0' }}>
                    Encara no has desbloquejat cap complement. Completa el
                    primer repte!
                  </p>
                )}

                {emojisDesbloqueados.map((item) => (
                  <button
                    key={item.emoji}
                    type="button"
                    title={item.texto}
                    onClick={() => alternarComplemento(item.emoji)}
                    style={{
                      fontSize: '28px',
                      width: '52px',
                      height: '52px',
                      borderRadius: '14px',
                      cursor: 'pointer',
                      border: complementos.includes(item.emoji)
                        ? '2px solid #6d5dfc'
                        : '1px solid #e0e0ee',
                      background: complementos.includes(item.emoji)
                        ? '#f5f3ff'
                        : '#ffffff',
                    }}
                  >
                    {item.emoji}
                  </button>
                ))}

              </div>

            </div>


            <div style={{ display: 'grid', gap: '16px' }}>

              {logros.map((cadena) => {
                const logrados = cadena.niveles.filter(
                  (nivel) => nivel.conseguido,
                )

                const siguiente = cadena.niveles.find(
                  (nivel) => !nivel.conseguido,
                )

                const ocultos = siguiente
                  ? cadena.niveles.length - logrados.length - 1
                  : 0

                return (
                  <article key={cadena.id} style={ESTILO_TARJETA}>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '8px',
                      }}
                    >
                      <strong style={{ fontSize: '18px' }}>
                        {cadena.icono} {cadena.titulo}
                      </strong>

                      <small style={{ color: '#9a9ab0' }}>
                        Nivell {logrados.length} / {cadena.niveles.length}
                      </small>
                    </div>

                    {logrados.length > 0 && (
                      <div
                        style={{
                          display: 'flex',
                          gap: '8px',
                          flexWrap: 'wrap',
                          marginTop: '12px',
                        }}
                      >
                        {logrados.map((nivel) => (
                          <span
                            key={nivel.id}
                            title={nivel.texto}
                            style={{ fontSize: '26px' }}
                          >
                            {nivel.emoji}
                          </span>
                        ))}
                      </div>
                    )}

                    {siguiente ? (
                      <div style={{ marginTop: '16px' }}>

                        <p style={{ fontWeight: 600 }}>
                          Següent repte: {siguiente.texto}
                        </p>

                        <p style={{ color: '#9a9ab0', margin: '4px 0 8px' }}>
                          Recompensa: {siguiente.emoji}
                        </p>

                        {siguiente.condiciones.map((condicion) => (
                          <div
                            key={condicion.etiqueta}
                            style={{ marginTop: '10px' }}
                          >

                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                marginBottom: '4px',
                                fontSize: '14px',
                              }}
                            >
                              <span>{condicion.etiqueta}</span>

                              <strong>
                                {Math.min(
                                  Math.round(condicion.valor),
                                  condicion.meta,
                                )}{' '}
                                / {condicion.meta}
                              </strong>
                            </div>

                            <BarraLogro
                              porcentaje={
                                (condicion.valor / condicion.meta) * 100
                              }
                            />

                          </div>
                        ))}

                        {ocultos > 0 && (
                          <small
                            style={{
                              display: 'block',
                              marginTop: '12px',
                              color: '#9a9ab0',
                            }}
                          >
                            🔒 {ocultos}{' '}
                            {ocultos === 1 ? 'repte' : 'reptes'} més per
                            descobrir
                          </small>
                        )}

                      </div>
                    ) : (
                      <p style={{ marginTop: '16px', fontWeight: 600 }}>
                        🏅 Cadena completada!
                      </p>
                    )}

                  </article>
                )
              })}

            </div>

          </section>
        )}

                {pantalla === 'estudio' && (
          <section className="page-section">

            <div className="page-heading">
              <div>
                <span className="eyebrow">MODE ESTUDI</span>
                <h1>Què vols fer avui?</h1>
                <p>Tria una activitat o segueix el pla d'avui.</p>
              </div>
              <span className="page-heading-index">✦</span>
            </div>

            <div style={{ ...ESTILO_TARJETA, marginBottom: '16px' }}>
              <span className="eyebrow">PLA D'AVUI</span>

              <div style={{ display: 'grid', gap: '10px', marginTop: '12px' }}>

                <button
                  className="app-button app-button-secondary"
                  type="button"
                  onClick={() => setPantalla('flashcards')}
                >
                  🎴 {estadoTarjetas.hoy} targetes per repassar avui
                </button>

                <button
                  className="app-button app-button-secondary"
                  type="button"
                  onClick={() => setPantalla('repaso')}
                >
                  🔴 {erroresRepaso.length} errors pendents de repassar
                </button>

                <button
                  className="app-button app-button-secondary"
                  type="button"
                  onClick={() => setPantalla('inicio')}
                >
                  ⚠️ {problemasRecurrentes.length} temes amb problemes recurrents
                </button>

              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '16px',
              }}
            >

              {[
                { icono: '📖', titulo: 'Estudiar teoria', detalle: 'Obre els teus PDFs per temes', destino: 'assignatures' },
                { icono: '📝', titulo: 'Fer exercicis', detalle: 'Practica amb exercicis per tema', destino: 'assignatures' },
                { icono: '🤖', titulo: 'Preguntar a la IA', detalle: 'El teu tutor personal', destino: 'ia' },
                { icono: '🧠', titulo: 'Repassar errors', detalle: 'Reforça el que has fallat', destino: 'repaso' },
                { icono: '🎴', titulo: 'Flashcards', detalle: 'Memoritza amb repàs espaiat', destino: 'flashcards' },
                                { icono: '📋', titulo: 'Fer examen', detalle: 'Normal o simulacre d\'1 hora', destino: 'examen' },
                                { icono: '🍅', titulo: 'Pomodoro', detalle: 'Estudia amb focus i guanya XP', destino: 'pomodoro' },
                { icono: '📝', titulo: 'Apunts', detalle: 'Resums amb IA i PDF', destino: 'apuntes' },
                { icono: '📅', titulo: "Pla d'estudi", detalle: 'Un pla dia a dia per a l\'examen', destino: 'plan' },
                                { icono: '🇬🇧', titulo: 'Anglès Professional', detalle: 'Vocabulari, redaccions i pronunciació', destino: 'ingles' },
              ].map((opcion) => (
                <button
                  key={opcion.titulo}
                  type="button"
                  onClick={() => setPantalla(opcion.destino)}
                  style={{
                    ...ESTILO_TARJETA,
                    border: 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontSize: '32px' }}>{opcion.icono}</div>
                  <strong style={{ display: 'block', marginTop: '8px' }}>
                    {opcion.titulo}
                  </strong>
                  <small style={{ color: '#9a9ab0' }}>{opcion.detalle}</small>
                </button>
              ))}

            </div>

          </section>
        )}


        {pantalla === 'flashcards' && (
          <section className="page-section">

            <button
              className="back-button"
              type="button"
              onClick={() => {
                setSesionTarjetasActiva(false)
                setPantalla('estudio')
              }}
            >
              <span>←</span>
              Tornar al mode estudi
            </button>

            <div className="page-heading">
              <div>
                <span className="eyebrow">MEMORITZACIÓ</span>
                <h1>Flashcards</h1>
                <p>Les que no saps tornen aviat; les que saps, cada cop més tard.</p>
              </div>
              <span className="page-heading-index">🎴</span>
            </div>

            {!sesionTarjetasActiva && (
              <div style={ESTILO_TARJETA}>

                <label
                  htmlFor="tema-flash"
                  style={{ display: 'block', marginBottom: '8px', fontWeight: 600 }}
                >
                  Tema
                </label>

                <select
                  id="tema-flash"
                  value={temaFlashId ?? ''}
                  onChange={(event) =>
                    setTemaFlashId(
                      event.target.value ? Number(event.target.value) : null,
                    )
                  }
                  style={ESTILO_SELECT}
                >
                  <option value="">Tots els temes (només per repassar)</option>

                  {progresoTemas.map((tema) => (
                    <option key={tema.id} value={tema.id}>
                      {tema.asignatura} · {tema.nombre}
                    </option>
                  ))}
                </select>

                <p style={{ margin: '16px 0' }}>
                  🎴 {estadoTarjetas.total} targetes ·{' '}
                  <strong>{estadoTarjetas.hoy}</strong> per repassar avui
                </p>

                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>

                  <button
                    className="app-button app-button-primary"
                    type="button"
                    disabled={estadoTarjetas.hoy === 0}
                    onClick={comenzarRepasoTarjetas}
                  >
                    ▶ Començar repàs
                  </button>

                  <button
                    className="app-button app-button-secondary"
                    type="button"
                    disabled={!temaFlashId || generandoTarjetas}
                    onClick={generarTarjetas}
                  >
                    {generandoTarjetas
                      ? 'Generant targetes...'
                      : '🤖 Generar targetes del tema'}
                  </button>

                </div>

                                      <div
                  style={{
                    display: 'flex',
                    gap: '8px',
                    flexWrap: 'wrap',
                    marginTop: '16px',
                  }}
                >

                  <button
                    className="app-button app-button-secondary"
                    type="button"
                    onClick={() => exportarTarjetas('csv')}
                  >
                    ⬇️ Exportar CSV
                  </button>

                  <button
                    className="app-button app-button-secondary"
                    type="button"
                    onClick={() => exportarTarjetas('anki')}
                  >
                    ⬇️ Exportar per a Anki
                  </button>

                  <label
                    className="app-button app-button-secondary"
                    style={{ cursor: 'pointer' }}
                  >
                    ⬆️ Importar
                    <input
                      type="file"
                      accept=".csv,.txt,.tsv"
                      onChange={importarTarjetas}
                      hidden
                    />
                  </label>

                </div>

                {!temaFlashId && (
                  <small style={{ display: 'block', marginTop: '12px', color: '#9a9ab0' }}>
                    Tria un tema per poder generar targetes noves.
                  </small>
                )}

              </div>
            )}

            {sesionTarjetasActiva && colaTarjetas.length > 0 && (
              <div style={ESTILO_TARJETA}>

                <small style={{ color: '#9a9ab0' }}>
                  Targeta {Math.min(tarjetasSabidas + 1, totalSesionTarjetas)} /{' '}
                  {totalSesionTarjetas}
                </small>

                <div
                  style={{
                    height: '8px',
                    borderRadius: '8px',
                    background: '#ececf4',
                    margin: '8px 0 20px',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${(tarjetasSabidas / totalSesionTarjetas) * 100}%`,
                      background: '#6d5dfc',
                    }}
                  />
                </div>

                <h2 style={{ marginBottom: '20px' }}>
                  {colaTarjetas[0].pregunta}
                </h2>

                {!respuestaVisible ? (
                  <button
                    className="app-button app-button-primary"
                    type="button"
                    onClick={() => setRespuestaVisible(true)}
                  >
                    Mostrar resposta
                  </button>
                ) : (
                  <>
                    <div
                      style={{
                        background: '#f5f3ff',
                        borderRadius: '16px',
                        padding: '16px',
                        lineHeight: 1.6,
                        marginBottom: '16px',
                      }}
                    >
                      {colaTarjetas[0].respuesta}
                    </div>

                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>

                      <button
                        className="app-button app-button-danger"
                        type="button"
                        onClick={() => valorarTarjeta(false)}
                      >
                        ❌ No la sé
                      </button>

                      <button
                        className="app-button app-button-primary"
                        type="button"
                        onClick={() => valorarTarjeta(true)}
                      >
                        ✅ La sé
                      </button>

                    </div>
                  </>
                )}

              </div>
            )}

            {sesionTarjetasActiva && colaTarjetas.length === 0 && (
              <div style={{ ...ESTILO_TARJETA, textAlign: 'center' }}>

                <div style={{ fontSize: '56px' }}>🎉</div>

                <h2>Sessió acabada!</h2>

                <p style={{ margin: '8px 0 20px' }}>
                  Has repassat {totalSesionTarjetas} targetes.
                </p>

                <button
                  className="app-button app-button-primary"
                  type="button"
                  onClick={() => {
                    setSesionTarjetasActiva(false)
                    contarTarjetas(temaFlashId)
                  }}
                >
                  Tornar
                </button>

              </div>
            )}

          </section>
        )}


        {pantalla === 'examen' && (
          <section className="page-section">

            <button
              className="back-button"
              type="button"
              onClick={() => {
                setExamen(null)
                setPantalla('estudio')
              }}
            >
              <span>←</span>
              Tornar al mode estudi
            </button>

            <div className="page-heading">
              <div>
                <span className="eyebrow">AVALUACIÓ</span>
                <h1>Fer examen</h1>
                <p>Respon sense ajuda. La correcció arriba al final.</p>
              </div>
              <span className="page-heading-index">📋</span>
            </div>

            {!examen && (
              <div style={ESTILO_TARJETA}>

                <label
                  htmlFor="tema-examen"
                  style={{ display: 'block', marginBottom: '8px', fontWeight: 600 }}
                >
                  Tema
                </label>

                <select
                  id="tema-examen"
                  value={temaExamenId ?? ''}
                  onChange={(event) =>
                    setTemaExamenId(
                      event.target.value ? Number(event.target.value) : null,
                    )
                  }
                  style={ESTILO_SELECT}
                >
                  <option value="">Tots els temes</option>

                  {progresoTemas.map((tema) => (
                    <option key={tema.id} value={tema.id}>
                      {tema.asignatura} · {tema.nombre}
                    </option>
                  ))}
                </select>

                                <label
                  htmlFor="modo-examen"
                  style={{ display: 'block', margin: '16px 0 8px', fontWeight: 600 }}
                >
                  Tipus d'examen
                </label>

                <select
                  id="modo-examen"
                  value={modoExamen}
                  onChange={(event) => {
                    const modo = event.target.value as 'normal' | 'simulacro'

                    setModoExamen(modo)
                    setNumPreguntasExamen(modo === 'simulacro' ? 20 : 10)
                  }}
                  style={ESTILO_SELECT}
                >
                  <option value="normal">Examen normal (sense límit de temps)</option>
                  <option value="simulacro">
                    Simulacre: 1 hora, correcció al final
                  </option>
                </select>

                <label
                  htmlFor="num-examen"
                  style={{ display: 'block', margin: '16px 0 8px', fontWeight: 600 }}
                >
                  Nombre de preguntes
                </label>

                <select
                  id="num-examen"
                  value={numPreguntasExamen}
                  onChange={(event) =>
                    setNumPreguntasExamen(Number(event.target.value))
                  }
                  style={ESTILO_SELECT}
                >
                  {(modoExamen === 'simulacro' ? [20, 30, 40] : [5, 10, 15]).map(
                    (cantidad) => (
                      <option key={cantidad} value={cantidad}>
                        {cantidad} preguntes
                      </option>
                    ),
                  )}
                </select>

                <button
                  className="app-button app-button-primary"
                  type="button"
                  disabled={preparandoExamen}
                  onClick={empezarExamen}
                  style={{ marginTop: '20px' }}
                >
                                    {preparandoExamen
                    ? 'Preparant examen...'
                    : modoExamen === 'simulacro'
                      ? 'Començar simulacre (1 hora)'
                      : 'Començar examen'}
                </button>

              </div>
            )}

                        {!examen && historialExamenes.length > 0 && (
              <div style={{ ...ESTILO_TARJETA, marginTop: '16px' }}>

                <span className="eyebrow">EL TEU HISTORIAL</span>

                <div style={{ width: '100%', height: 220, marginTop: '12px' }}>

                  <ResponsiveContainer width="100%" height="100%">

                    <AreaChart
                      data={historialExamenes}
                      margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                    >

                      <defs>
                        <linearGradient
                          id="gradienteNotas"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop offset="0%" stopColor="#6d5dfc" stopOpacity={0.4} />
                          <stop offset="100%" stopColor="#6d5dfc" stopOpacity={0} />
                        </linearGradient>
                      </defs>

                      <CartesianGrid
                        strokeDasharray="3 6"
                        vertical={false}
                        stroke="#ececf4"
                      />

                      <XAxis
                        dataKey="fecha"
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 12, fill: '#9a9ab0' }}
                      />

                      <YAxis
                        domain={[0, 100]}
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 12, fill: '#9a9ab0' }}
                      />

                      <Tooltip
                        formatter={(valor) => `${valor}%`}
                        contentStyle={{
                          borderRadius: '14px',
                          border: 'none',
                          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
                          fontSize: '13px',
                        }}
                      />

                      <Area
                        type="monotone"
                        dataKey="nota"
                        name="Nota"
                        stroke="#6d5dfc"
                        strokeWidth={3}
                        fill="url(#gradienteNotas)"
                        activeDot={{ r: 6 }}
                      />

                    </AreaChart>

                  </ResponsiveContainer>

                </div>

                <small style={{ color: '#9a9ab0' }}>
                  Últims {historialExamenes.length} exàmens (normals i
                  simulacres). Nota = % d'encerts.
                </small>

              </div>
            )}

            {examen && examen.fase === 'respondiendo' && (
              <div style={ESTILO_TARJETA}>

                                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <small style={{ color: '#9a9ab0' }}>
                    Pregunta {examen.indice + 1} / {examen.preguntas.length}
                  </small>

                  {segundosRestantes !== null && (
                    <strong
                      style={{
                        color: segundosRestantes <= 300 ? '#e5646e' : '#6d5dfc',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      ⏱️ {formatoTiempo(segundosRestantes)}
                    </strong>
                  )}
                </div>

                <div
                  style={{
                    height: '8px',
                    borderRadius: '8px',
                    background: '#ececf4',
                    margin: '8px 0 20px',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${((examen.indice + 1) / examen.preguntas.length) * 100}%`,
                      background: '#6d5dfc',
                    }}
                  />
                </div>

                <h3>{examen.preguntas[examen.indice].titulo}</h3>

                <p style={{ margin: '8px 0 16px', lineHeight: 1.6 }}>
                  {examen.preguntas[examen.indice].enunciado}
                </p>

                <textarea
                  className="exercise-textarea"
                  rows={5}
                  placeholder="Escriu aquí la teva resposta..."
                  value={examen.respuestas[examen.indice]}
                  onChange={(event) =>
                    setExamen({
                      ...examen,
                      respuestas: examen.respuestas.map((respuesta, i) =>
                        i === examen.indice ? event.target.value : respuesta,
                      ),
                    })
                  }
                />

                <div
                  style={{
                    display: 'flex',
                    gap: '12px',
                    flexWrap: 'wrap',
                    marginTop: '16px',
                  }}
                >

                  <button
                    className="app-button app-button-secondary"
                    type="button"
                    disabled={examen.indice === 0}
                    onClick={() =>
                      setExamen({ ...examen, indice: examen.indice - 1 })
                    }
                  >
                    ← Anterior
                  </button>

                  {examen.indice < examen.preguntas.length - 1 ? (
                    <button
                      className="app-button app-button-primary"
                      type="button"
                      onClick={() =>
                        setExamen({ ...examen, indice: examen.indice + 1 })
                      }
                    >
                      Següent →
                    </button>
                  ) : (
                    <button
                      className="app-button app-button-primary"
                      type="button"
                      onClick={finalizarExamen}
                    >
                      Finalitzar examen
                    </button>
                  )}

                  <button
                    className="app-button app-button-danger"
                    type="button"
                    onClick={() => {
                      if (window.confirm("Segur que vols cancel·lar l'examen?")) {
                        setExamen(null)
                      }
                    }}
                  >
                    Cancel·lar
                  </button>

                </div>

              </div>
            )}

            {examen && examen.fase === 'corrigiendo' && (
              <div style={{ ...ESTILO_TARJETA, textAlign: 'center' }}>

                <div style={{ fontSize: '48px' }}>⏳</div>

                <h2>Corregint l'examen...</h2>

                <p style={{ marginTop: '8px' }}>
                  {examen.progreso} / {examen.preguntas.length} preguntes corregides
                </p>

              </div>
            )}

            {examen && examen.fase === 'resultado' && (
              <div style={{ display: 'grid', gap: '16px' }}>

                <div style={{ ...ESTILO_TARJETA, textAlign: 'center' }}>

                  <span className="eyebrow">RESULTAT</span>

                  <h2
                    style={{
                      fontSize: '56px',
                      margin: '8px 0',
                      color: '#6d5dfc',
                    }}
                  >
                    {aciertosExamen} / {examen.preguntas.length}
                  </h2>

                  <p style={{ fontSize: '20px' }}>
                    {Math.round((aciertosExamen / examen.preguntas.length) * 100)}%
                  </p>

                </div>

                {examen.recomendacion && (
                  <div style={ESTILO_TARJETA}>
                    <span className="eyebrow">RECOMANACIÓ DE LA IA</span>
                    <p style={{ marginTop: '8px', lineHeight: 1.6 }}>
                      {examen.recomendacion}
                    </p>
                  </div>
                )}

                {aciertosExamen < examen.preguntas.length && (
                  <div style={ESTILO_TARJETA}>

                    <span className="eyebrow">ERRORS PRINCIPALS</span>

                    {examen.preguntas.map((pregunta, i) => {
                      if (examen.resultados[i]?.correcta) {
                        return null
                      }

                      const temaDeLaPregunta = progresoTemas.find(
                        (tema) => tema.id === pregunta.tema_id,
                      )

                      return (
                        <div
                          key={pregunta.id}
                          style={{
                            marginTop: '16px',
                            paddingTop: '16px',
                            borderTop: '1px solid #ececf4',
                          }}
                        >

                          <small style={{ color: '#9a9ab0' }}>
                            {temaDeLaPregunta?.nombre ?? 'Tema'}
                          </small>

                          <p style={{ margin: '4px 0', fontWeight: 600 }}>
                            {pregunta.enunciado}
                          </p>

                          <p style={{ color: '#e5646e' }}>
                            La teva resposta:{' '}
                            {examen.respuestas[i].trim() || '(sense resposta)'}
                          </p>

                          <p style={{ color: '#2f9e6e' }}>
                            Solució: {pregunta.solucion}
                          </p>

                        </div>
                      )
                    })}

                  </div>
                )}

                <button
                  className="app-button app-button-primary"
                  type="button"
                  onClick={() => setExamen(null)}
                >
                  Fer un altre examen
                </button>

              </div>
            )}

          </section>
        )}

                {pantalla === 'ia' && (
          <section className="page-section">

            <div className="page-heading">

              <div>

                <span className="eyebrow">
                  TUTOR PERSONAL
                </span>

                <h1>
                  La meva IA
                </h1>

                <p>
                  Pregunta-li el que no entenguis. Si tries un tema,
                  respondrà amb els teus apunts.
                </p>

              </div>

              <span className="page-heading-index">
                ✦
              </span>

            </div>


            <div
              style={{
                background: '#ffffff',
                borderRadius: '20px',
                padding: '16px 20px',
                boxShadow: '0 8px 30px rgba(109, 93, 252, 0.08)',
                marginBottom: '16px',
              }}
            >

              <label
                htmlFor="tema-chat"
                style={{ display: 'block', marginBottom: '8px', fontWeight: 600 }}
              >
                Tema de context
              </label>

              <select
                id="tema-chat"
                value={temaChatId ?? ''}
                onChange={(event) => seleccionarTemaChat(event.target.value)}
                disabled={cargandoContextoChat}
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: '12px',
                  border: '1px solid #e0e0ee',
                  fontSize: '15px',
                }}
              >

                <option value="">
                  Sense tema (coneixement general)
                </option>

                {progresoTemas.map((tema) => (
                  <option key={tema.id} value={tema.id}>
                    {tema.asignatura} · {tema.nombre}
                  </option>
                ))}

              </select>

              {cargandoContextoChat && (
                <small style={{ display: 'block', marginTop: '8px' }}>
                  Carregant el material del tema...
                </small>
              )}

              {temaChatId !== null &&
                !cargandoContextoChat &&
                contextoChat === '' && (
                  <small style={{ display: 'block', marginTop: '8px' }}>
                    Aquest tema no té cap PDF: respondré amb coneixement general.
                  </small>
                )}

            </div>


            {temaChatId !== null && !cargandoContextoChat && (
              <div
                style={{
                  display: 'flex',
                  gap: '8px',
                  flexWrap: 'wrap',
                  marginBottom: '16px',
                }}
              >

                {[
                  {
                    etiqueta: "🧠 Explica-m'ho fàcil",
                    pregunta:
                      'Explícame este tema de forma muy sencilla, como si no supiera nada, con un ejemplo real.',
                  },
                  {
                    etiqueta: "💡 Posa'm un exemple",
                    pregunta:
                      'Ponme un ejemplo práctico de lo más importante de este tema.',
                  },
                  {
                    etiqueta: '📝 Resum',
                    pregunta:
                      'Hazme un resumen corto con los conceptos y definiciones que tengo que memorizar de este tema.',
                  },
                  {
                    etiqueta: '🌳 Esquema',
                    pregunta:
                      'Hazme un esquema con guiones y sangrías de este tema.',
                  },
                ].map((accion) => (
                  <button
                    className="app-button app-button-secondary"
                    type="button"
                    key={accion.etiqueta}
                    disabled={escribiendoChat}
                    onClick={() => enviarMensajeChat(accion.pregunta, true)}
                  >
                    {accion.etiqueta}
                  </button>
                ))}

              </div>
            )}


            <div
              style={{
                background: '#ffffff',
                borderRadius: '24px',
                padding: '20px',
                boxShadow: '0 10px 40px rgba(109, 93, 252, 0.10)',
                marginBottom: '16px',
              }}
            >

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  minHeight: '240px',
                  maxHeight: '460px',
                  overflowY: 'auto',
                  padding: '4px',
                }}
              >

                {mensajesChat.length === 0 && (
                  <p
                    style={{
                      color: '#9a9ab0',
                      textAlign: 'center',
                      margin: 'auto',
                    }}
                  >
                    Escriu una pregunta per començar.
                  </p>
                )}

                {mensajesChat.map((mensaje, index) => (
                  <div
                    key={index}
                    style={{
                      alignSelf:
                        mensaje.rol === 'usuario' ? 'flex-end' : 'flex-start',
                      maxWidth: '85%',
                      padding: '12px 16px',
                      borderRadius: '18px',
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.5,
                      background:
                        mensaje.rol === 'usuario' ? '#6d5dfc' : '#f5f3ff',
                      color:
                        mensaje.rol === 'usuario' ? '#ffffff' : '#2b2b3a',
                    }}
                  >
                    {mensaje.texto}
                  </div>
                ))}

                {escribiendoChat && (
                  <div
                    style={{
                      alignSelf: 'flex-start',
                      padding: '12px 16px',
                      borderRadius: '18px',
                      background: '#f5f3ff',
                      color: '#9a9ab0',
                    }}
                  >
                    Pensant...
                  </div>
                )}

                <div ref={finChatRef} />

              </div>

            </div>


            <div
              style={{
                display: 'flex',
                gap: '12px',
                alignItems: 'flex-end',
              }}
            >

              <textarea
                className="exercise-textarea"
                rows={2}
                placeholder="Escriu la teva pregunta..."
                value={textoChat}
                onChange={(event) => setTextoChat(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    enviarMensajeChat()
                  }
                }}
                style={{ flex: 1 }}
              />

                

              <BotonDictado
                idioma={idiomaDictado}
                onIdioma={setIdiomaDictado}
                idiomas={IDIOMAS_DICTADO}
                onTexto={(texto) =>
                  setTextoChat((actual) => (actual ? `${actual} ${texto}` : texto))
                }
              />

              <button
                className="app-button app-button-primary"
                type="button"
                disabled={escribiendoChat || textoChat.trim() === ''}
                onClick={() => enviarMensajeChat()}
              >
                Enviar
              </button>

            </div>


            {mensajesChat.length > 0 && (
              <button
                className="app-button app-button-secondary"
                type="button"
                onClick={limpiarHistorialChat}
                style={{ marginTop: '12px' }}
              >
                Netejar xat
              </button>
            )}

          </section>
        )}


        {pantalla === 'progres' && (
  <section className="page-section progress-page">
    

    <div className="progress-hero">
      <div>
        <span className="eyebrow">
          EL TEU PROGRÉS
        </span>

        <h1>
          Continua avançant.
        </h1>

        <p>
          Aquí pots veure com avances amb els exercicis i les assignatures.
        </p>
      </div>

      <div className="progress-level-badge">
        <span>NIVELL</span>
        <strong>{obtenerNivel()}</strong>
      </div>
    </div>

    <div className="progress-overview">

      <article className="progress-main-card">

        <div className="progress-card-top">
          <div>
            <span>XP ACTUAL</span>

            <strong>
              {xp} XP
            </strong>
          </div>

          <div className="progress-xp-icon">
            ✦
          </div>
        </div>

        <div className="progress-xp-info">
          <span>
            Progrés fins al nivell {obtenerNivel() + 1}
          </span>

          <strong>
            {obtenerXpNivelActual()} / 200 XP
          </strong>
        </div>

        <div className="progress-xp-bar">
          <div
  style={{
    width: `${(obtenerXpNivelActual() / 200) * 100}%`,
    height: '100%',
    background: '#6d5dfc',
  }}
/>
        </div>

      </article>


      <article className="progress-mini-card">

        <span className="progress-mini-icon">
          ✓
        </span>

        <span>
          COMPLETATS
        </span>

        <strong>
          {ejerciciosCompletados}
        </strong>

        <small>
          exercicis
        </small>

      </article>


      <article className="progress-mini-card">

        <span className="progress-mini-icon">
          ↗
        </span>

        <span>
          CORRECTES
        </span>

        <strong>
          {ejerciciosCorrectos}
        </strong>

        <small>
          respostes
        </small>

      </article>


      <article className="progress-mini-card">

        <span className="progress-mini-icon">
          !
        </span>

        <span>
          A REVISAR
        </span>

        <strong>
          {ejerciciosIncorrectos}
        </strong>

        <small>
          exercicis
        </small>

      </article>

    </div>


    <div className="progress-section">

      <div className="progress-section-header">

        <span>
          ASSIGNATURES
        </span>

        <h2>
          El teu progrés
        </h2>

      </div>


      <div className="progress-subject-grid">

        {progresoAsignaturas.map((asignatura) => {

          

const porcentaje =
  asignatura.total === 0
    ? 0
    : (asignatura.completados / asignatura.total) * 100

          return (
            <article
              className="progress-subject-card"
              key={asignatura.nombre}
            >

              <div className="progress-subject-header">

                <div className="progress-subject-number">
                  {asignatura.completados}
                </div>

                <div>

                  <strong>
                    {asignatura.nombre}
                  </strong>

                  <span>
                    {asignatura.completados} de {asignatura.total} exercicis
                  </span>

                </div>

              </div>


              <div className="progress-subject-bar">
                <div
  style={{
width: `${porcentaje}%`,
  }}
/>
              </div>

            </article>
          )
        })}

      </div>

    </div>

        <div className="progress-section">

      <div className="progress-section-header">

        <span>
          PER TEMA
        </span>

        <h2>
          On tens problemes
        </h2>

      </div>


      {progresoTemas.filter(
        (tema) => tema.correctas + tema.incorrectas > 0,
      ).length === 0 ? (
        <p>
          Encara no has respost cap exercici.
        </p>
      ) : (
        <div className="progress-subject-grid">

          {[...progresoTemas]
            .filter((tema) => tema.correctas + tema.incorrectas > 0)
            .sort(
              (a, b) =>
                a.correctas / (a.correctas + a.incorrectas) -
                b.correctas / (b.correctas + b.incorrectas),
            )
            .map((tema) => {
              const total = tema.correctas + tema.incorrectas

              const porcentaje = Math.round(
                (tema.correctas / total) * 100,
              )

              return (
                <article
                  className="progress-subject-card"
                  key={tema.id}
                >

                  <div className="progress-subject-header">

                    <div className="progress-subject-number">
                      {porcentaje}%
                    </div>

                    <div>

                      <strong>
                        {tema.nombre}
                      </strong>

                      <span>
                        {tema.asignatura} · {tema.correctas} correctes, {tema.incorrectas} errors
                      </span>

                                            {tema.dificultad && (
                        <span
                          style={{
                            display: 'block',
                            marginTop: '4px',
                            color: '#6d5dfc',
                            fontWeight: 600,
                          }}
                        >
                          Nivell:{' '}
                          {tema.dificultad === 'dificil'
                            ? 'Difícil'
                            : tema.dificultad === 'media'
                              ? 'Mitjà'
                              : 'Fàcil'}
                        </span>
                      )}

                                          {problemasRecurrentes.some(
                        (problema) => problema.id === tema.id,
                      ) && (
                        <span
                          style={{
                            display: 'block',
                            marginTop: '4px',
                            color: '#e5646e',
                            fontWeight: 600,
                          }}
                        >
                          ⚠️ Problema recurrent
                        </span>
                      )}

                    </div>

                  </div>


                  <div className="progress-subject-bar">
                    <div
                      style={{
                        width: `${porcentaje}%`,
                      }}
                    />
                  </div>

                </article>
              )
            })}

        </div>
      )}

    </div>  

        <div className="progress-section">

      <div className="progress-section-header">

        <span>
          ESTADÍSTIQUES
        </span>

        <h2>
          El teu rendiment
        </h2>

      </div>


      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '16px',
        }}
      >

        <article className="progress-mini-card">
          <span className="progress-mini-icon">%</span>
          <span>ENCERT</span>
          <strong>{estadisticas.porcentajeAcierto}%</strong>
          <small>de les respostes</small>
        </article>

        <article className="progress-mini-card">
          <span className="progress-mini-icon">✦</span>
          <span>XP TOTAL</span>
          <strong>{estadisticas.xpTotal}</strong>
          <small>guanyada</small>
        </article>

        <article className="progress-mini-card">
          <span className="progress-mini-icon">⌀</span>
          <span>XP MITJANA</span>
          <strong>{estadisticas.xpMedia}</strong>
          <small>per exercici</small>
        </article>

        <article className="progress-mini-card">
          <span className="progress-mini-icon">↻</span>
          <span>INTENTS MITJANS</span>
          <strong>{estadisticas.intentosMedios}</strong>
          <small>per exercici</small>
        </article>

        <article className="progress-mini-card">
          <span className="progress-mini-icon">↑</span>
          <span>MÉS PRACTICADA</span>
          <strong>{estadisticas.asignaturaMas}</strong>
          <small>assignatura</small>
        </article>

        <article className="progress-mini-card">
          <span className="progress-mini-icon">↓</span>
          <span>MENYS PRACTICADA</span>
          <strong>{estadisticas.asignaturaMenos}</strong>
          <small>assignatura</small>
        </article>

      </div>

    </div>

            <div className="progress-section">

      <div className="progress-section-header">

        <span>
          EVOLUCIÓ
        </span>

        <h2>
          Els teus últims 14 dies
        </h2>

      </div>


      <div
        style={{
          background: '#ffffff',
          borderRadius: '24px',
          padding: '24px',
          boxShadow: '0 10px 40px rgba(109, 93, 252, 0.10)',
        }}
      >

        <div
          style={{
            display: 'flex',
            gap: '24px',
            marginBottom: '16px',
            fontSize: '13px',
            color: '#6b6b80',
          }}
        >

          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span
              style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: '#6d5dfc',
              }}
            />
            Correctes
          </span>

          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span
              style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: '#e5646e',
              }}
            />
            Errors
          </span>

        </div>


        <div style={{ width: '100%', height: 280 }}>

          <ResponsiveContainer width="100%" height="100%">

            <AreaChart
              data={evolucion}
              margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
            >

              <defs>

                <linearGradient
                  id="gradienteCorrectas"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor="#6d5dfc" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#6d5dfc" stopOpacity={0} />
                </linearGradient>

                <linearGradient
                  id="gradienteErrores"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor="#e5646e" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#e5646e" stopOpacity={0} />
                </linearGradient>

              </defs>

              <CartesianGrid
                strokeDasharray="3 6"
                vertical={false}
                stroke="#ececf4"
              />

              <XAxis
                dataKey="dia"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 12, fill: '#9a9ab0' }}
                interval="preserveStartEnd"
              />

              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 12, fill: '#9a9ab0' }}
              />

              <Tooltip
                contentStyle={{
                  borderRadius: '14px',
                  border: 'none',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
                  fontSize: '13px',
                }}
                cursor={{
                  stroke: '#6d5dfc',
                  strokeOpacity: 0.2,
                  strokeWidth: 2,
                }}
              />

              <Area
                type="monotone"
                dataKey="correctas"
                name="Correctes"
                stroke="#6d5dfc"
                strokeWidth={3}
                fill="url(#gradienteCorrectas)"
                dot={false}
                activeDot={{ r: 6 }}
              />

              <Area
                type="monotone"
                dataKey="errores"
                name="Errors"
                stroke="#e5646e"
                strokeWidth={3}
                fill="url(#gradienteErrores)"
                dot={false}
                activeDot={{ r: 6 }}
              />

            </AreaChart>

          </ResponsiveContainer>

        </div>

      </div>

    </div>

           <div
      style={{
        ...ESTILO_TARJETA,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '12px',
      }}
    >

      <div>

        <span className="eyebrow">
          ASSOLIMENTS
        </span>

        <h3 style={{ margin: '4px 0' }}>
          🏆 {emojisDesbloqueados.length} / {totalNiveles} reptes assolits
        </h3>

        <small style={{ color: '#9a9ab0' }}>
          Desbloqueja emojis per a la teva foto de perfil
        </small>

      </div>

      <button
        className="app-button app-button-primary"
        type="button"
        onClick={() => setPantalla('logros')}
      >
        Veure assoliments →
      </button>

    </div>

    <div className="progress-bottom-card">

      <div className="progress-bottom-icon">
        ⚡
      </div>


      <div>

        <span>
          PROPER OBJECTIU
        </span>

        <h2>
          Arribar al nivell {obtenerNivel() + 1}
        </h2>

        <p className="progress-goal-text">
  Et falten <strong>{200 - obtenerXpNivelActual()} XP</strong> per pujar de nivell.
</p>

</div>

      <div className="progress-bottom-value">

        <strong>
          {obtenerXpNivelActual()}
        </strong>

        <span>
          / 200 XP
        </span>

      </div>
      
      <div className="progress-bottom-bar">
  <div
    style={{
      width: `${(obtenerXpNivelActual() / 200) * 100}%`,
    }}
  />
</div>
    </div>

  </section>
)}


</main>


<footer
  className="app-footer"
  style={{
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 900,
    margin: 0,
    padding: '12px 0',
    background: '#ffffff',
    borderTop: '1px solid #ececf4',
    boxShadow: '0 -6px 24px rgba(109, 93, 252, 0.12)',
  }}
>

  <div
  className="footer-inner"
  style={{
    position: 'static',
    transform: 'none',
    width: '100%',
    maxWidth: '1200px',
    margin: '0 auto',
    padding: '0 24px',
    boxSizing: 'border-box',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    flexWrap: 'wrap',
  }}
>

    <div className="footer-brand">

      <span className="footer-logo">
        GS
      </span>

      <div>

        <strong>
          GS Marqueting i Publicitat
        </strong>

        <span>
          Espai d'estudi
        </span>

      </div>

    </div>


    <div className="footer-navigation">

      <BottomNav
        pantalla={pantalla}
        setPantalla={setPantalla}
      />

    </div>


    <div className="footer-copy">

      <span>
        FP · Marqueting i Publicitat
      </span>

      <span>
        © 2026
      </span>

    </div>

  </div>

</footer>

</div>
  )
}

function App() {
  return (
    <LimiteErrores>
      <AppInterna />
    </LimiteErrores>
  )
}

export default App