const express = require('express')
const { PDFParse } = require('pdf-parse')

const cors = require('cors')
const multer = require('multer')

const upload = multer({
  storage: multer.memoryStorage(),
})

// ----- IA en la nube (opcional) -----
// Si existen IA_URL e IA_KEY, las llamadas a Ollama se redirigen a un
// proveedor compatible con OpenAI (por ejemplo Groq). Si no, se usa Ollama.
const fetchOriginal = globalThis.fetch.bind(globalThis)

if (process.env.IA_URL && process.env.IA_KEY) {
  const modeloNube = process.env.IA_MODELO || 'llama-3.3-70b-versatile'

  globalThis.fetch = async (url, opciones = {}) => {
    const direccion = typeof url === 'string' ? url : url.url || String(url)

    if (!direccion.startsWith('http://localhost:11434/api/')) {
      return fetchOriginal(url, opciones)
    }

    const ruta = direccion.replace('http://localhost:11434', '')
    const cabeceras = { 'Content-Type': 'application/json' }

    if (ruta === '/api/tags') {
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: cabeceras,
      })
    }

    const cuerpo = JSON.parse(opciones.body || '{}')

    const peticion = {
      model: modeloNube,
      messages:
        ruta === '/api/chat'
          ? cuerpo.messages
          : [{ role: 'user', content: cuerpo.prompt }],
      temperature: cuerpo.options?.temperature ?? 0.3,
    }

    if (cuerpo.format === 'json') {
      peticion.response_format = { type: 'json_object' }
    }

    const respuesta = await fetchOriginal(`${process.env.IA_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.IA_KEY}`,
      },
      body: JSON.stringify(peticion),
    })

    if (!respuesta.ok) {
      const detalle = await respuesta.text()

      console.error('Error del proveedor de IA:', respuesta.status, detalle)

      return new Response(JSON.stringify({ error: detalle }), {
        status: respuesta.status,
        headers: cabeceras,
      })
    }

    const datos = await respuesta.json()
    const texto = datos.choices?.[0]?.message?.content ?? ''

    const resultado =
      ruta === '/api/chat'
        ? { message: { role: 'assistant', content: texto } }
        : { response: texto }

    return new Response(JSON.stringify(resultado), {
      status: 200,
      headers: cabeceras,
    })
  }
}

const app = express()

const origenesPermitidos = (process.env.ORIGENES_PERMITIDOS || '')
  .split(',')
  .map((origen) => origen.trim())
  .filter(Boolean)

app.use(
  cors({
    origin: (origin, callback) => {
      const permitido =
        !origin ||
        origenesPermitidos.includes(origin) ||
        /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin)

      callback(permitido ? null : new Error('Origen no permitido'), permitido)
    },
  }),
)

app.use(express.json({ limit: '25mb' }))

// ----- Acceso: en la nube solo entra quien tenga sesión de Supabase -----
const tokensValidos = new Map()

app.use(async (req, res, next) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return next()
  }

  if (req.method === 'OPTIONS' || req.path === '/' || req.path === '/estado') {
    return next()
  }

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()

  if (!token) {
    return res.status(401).json({ error: 'No autoritzat.' })
  }

  const caducidad = tokensValidos.get(token)

  if (caducidad && caducidad > Date.now()) {
    return next()
  }

  try {
    const respuesta = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: process.env.SUPABASE_ANON_KEY,
      },
    })

    if (!respuesta.ok) {
      return res.status(401).json({ error: 'Sessió no vàlida.' })
    }

    tokensValidos.set(token, Date.now() + 5 * 60 * 1000)

    next()
  } catch (error) {
    console.error('Error comprobando la sesión:', error)

    res.status(500).json({ error: 'No es pot comprovar la sessió.' })
  }
})

app.get('/', (req, res) => {
  res.json({
    mensaje: 'Servidor IA funcionando',
  })
})

app.post('/corregir', async (req, res) => {
  try {
    const {
      enunciado,
      solucion,
      respuesta,
      dificultad,
      xp,
    } = req.body

    const xpMaxima = Number(xp)

    const prompt = `
Eres un profesor de Formación Profesional.

Debes evaluar la respuesta de un alumno comparándola con la solución esperada.

EJERCICIO:
${enunciado}

SOLUCIÓN ESPERADA:
${solucion}

RESPUESTA DEL ALUMNO:
${respuesta}

DIFICULTAD:
${dificultad}

XP MÁXIMA:
${xpMaxima}

IMPORTANTE:

Evalúa el significado de la respuesta del alumno, no si utiliza exactamente
las mismas palabras que la solución esperada.

La respuesta debe considerarse correcta cuando expresa las mismas ideas esenciales
que la solución, aunque:

- utilice palabras diferentes;
- utilice sinónimos;
- cambie el orden de las ideas;
- explique la idea con otras palabras;
- sea más breve que la solución;
- tenga pequeños errores de redacción que no cambien el significado.

NO exijas que el alumno copie literalmente la solución.

NO penalices una respuesta simplemente porque sea más corta si contiene
la información esencial necesaria para responder al ejercicio.

Solo considera una idea como ausente cuando realmente falta esa información
en la respuesta.

Ejemplo:

SOLUCIÓN:
"Empresa Rhone Alpes Servicios España SLU es una empresa de servicios que
ofrece soluciones de seguridad y gestión de riesgos para empresas y particulares."

RESPUESTA:
"Rhone Alpes Servicios España SLU ofrece servicios de seguridad y gestión
de riesgos para empresas y particulares."

Resultado esperado:
{
  "ideas_esenciales": 2,
  "ideas_presentes": 2,
  "comentario": "La respuesta expresa las mismas ideas esenciales que la solución,
aunque utiliza una redacción diferente."
}

Otro ejemplo:

SOLUCIÓN:
"Dividir el mercado en grupos de consumidores con características similares."

RESPUESTA:
"La segmentación consiste en dividir el mercado en grupos."

Resultado esperado:
{
  "ideas_esenciales": 2,
  "ideas_presentes": 1,
  "comentario": "La respuesta indica que el mercado se divide en grupos,
pero no menciona que los grupos tienen características similares."
}

No decidas la XP.
No devuelvas "correcta", "parcial" ni "incorrecta".
Devuelve SOLO un JSON válido con este formato:

{
  "ideas_esenciales": 2,
  "ideas_presentes": 1,
  "comentario": "Explicación breve."
}
Devuelve SOLO un JSON válido.

Formato obligatorio:

{
  "ideas_esenciales": 2,
  "ideas_presentes": 1,
  "comentario": "Explicación breve."
}

"ideas_esenciales" debe ser un número entero.
"ideas_presentes" debe ser un número entero entre 0 e "ideas_esenciales".

No devuelvas ningún otro campo.
`

    console.log('RESPUESTA DEL ALUMNO ENVIADA A IA:', respuesta)    
    console.log('SOLUCIÓN ENVIADA A IA:', solucion)

    const respuestaOllama = await fetch(
      'http://localhost:11434/api/generate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.IA_MODELO || 'llama-3.3-70b-versatile',
          prompt,
          stream: false,
          format: 'json',
          options: {
            temperature: 0,
          },
        }),
      },
    )

    if (!respuestaOllama.ok) {
      throw new Error(
        `El servicio de IA respondió con ${respuestaOllama.status}`,
      )
    }

    const datos = await respuestaOllama.json()

    let texto = (datos.response || datos.choices?.[0]?.message?.content || '').trim()

    console.log(
      'RESPUESTA DE LA IA:',
      texto,
    )

    texto = texto
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()

    const correccion = JSON.parse(texto)

    const respuestaNormalizada = respuesta.trim().toLowerCase()
    const solucionNormalizada = solucion.trim().toLowerCase()

    if (respuestaNormalizada === solucionNormalizada) {
      res.json({
        correcta: true,
        xp: xpMaxima,
        comentario: 'La respuesta coincide con la solución esperada.',
      })
      return
    }

    const ideasEsenciales = Number(correccion.ideas_esenciales)
    const ideasPresentes = Number(correccion.ideas_presentes)

    console.log('IDEAS ESENCIALES:', ideasEsenciales)
    console.log('IDEAS PRESENTES:', ideasPresentes)

    if (
      !Number.isInteger(ideasEsenciales) ||
      !Number.isInteger(ideasPresentes) ||
      ideasEsenciales <= 0 ||
      ideasPresentes < 0 ||
      ideasPresentes > ideasEsenciales
    ) {
      throw new Error('La IA devolvió un número de ideas inválido.')
    }

    let xpFinal = 0
    let correctaFinal = false

    if (ideasPresentes === ideasEsenciales) {
      xpFinal = xpMaxima
      correctaFinal = true
    }

    const resultadoFinal = {
      correcta: correctaFinal,
      xp: xpFinal,
      comentario: String(correccion.comentario || '').trim(),
    }

    console.log('RESULTADO FINAL:', resultadoFinal)

    res.json(resultadoFinal)
  } catch (error) {
    console.error('Error corrigiendo respuesta:', error)

    res.status(500).json({
      error: 'No se ha podido corregir la respuesta.',
    })
  }
})

app.post('/extraer-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No se ha recibido ningún PDF.',
      })
    }

    const parser = new PDFParse({
      data: req.file.buffer,
    })

    const resultado = await parser.getText()

    await parser.destroy()

    const texto = resultado.text

    res.json({
      texto,
    })
  } catch (error) {
    console.error('Error extrayendo PDF:', error)

    res.status(500).json({
      error: 'No se ha podido leer el PDF.',
    })
  }
})

app.post('/generar-recomendacion', async (req, res) => {
  console.log('ENTRÓ EN GENERAR-RECOMENDACION')

  try {
    const { recomendaciones } = req.body

    const prompt = `
Eres un tutor personalizado de un estudiante de Grado Superior de Marketing y Publicidad.

Analiza estos datos sobre sus ejercicios:

${JSON.stringify(recomendaciones, null, 2)}

Genera UNA recomendación breve y personalizada sobre qué debería reforzar.

No inventes contenidos que no aparezcan en los datos.
No hagas una lista.
Habla directamente al estudiante.
La recomendación debe ser clara, útil y motivadora.

Devuelve únicamente el texto de la recomendación.
`

    console.log('LLAMANDO A LA IA PARA RECOMENDACIÓN')

    const respuesta = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.IA_MODELO || 'llama-3.3-70b-versatile',
        prompt,
        stream: false,
      }),
    })

    const datos = await respuesta.json()
    const textoRespuesta = datos.response || datos.choices?.[0]?.message?.content || ''

    res.json({
      recomendacion: textoRespuesta,
    })
  } catch (error) {
    console.error('ERROR GENERANDO RECOMENDACIÓN:', error)

    res.status(500).json({
      error: 'No se pudo generar la recomendación',
    })
  }
})

function instruccionDificultad(dificultad) {
  const descripciones = {
    facil: 'una sola idea principal, con una pregunta directa y sencilla de comprensión',
    media: 'aplicar un concepto a una situación concreta y sencilla',
    dificil: 'un caso práctico que obligue a combinar varios conceptos o a justificar una decisión',
  }

  if (!descripciones[dificultad]) {
    return ''
  }

  return `
DIFICULTAD OBLIGATORIA: los ejercicios deben ser de dificultad "${dificultad}": ${descripciones[dificultad]}.
Pon "${dificultad}" en el campo "dificultad".
`
}

app.post('/generar-un-ejercicio', async (req, res) => {
  try {
    const { texto, ejerciciosAnteriores } = req.body

    if (!texto) {
      return res.status(400).json({
        error: 'No se ha recibido texto.',
      })
    }

    const prompt = `
Eres profesor de Formación Profesional de Marketing y Publicidad.

A partir del contenido proporcionado, crea UN SOLO ejercicio práctico y ORIGINAL.${instruccionDificultad(req.body.dificultad)}

CONTENIDO:
${texto}

EJERCICIOS ANTERIORES QUE NO DEBES REPETIR:
${JSON.stringify(ejerciciosAnteriores ?? [])}

El ejercicio debe estar basado únicamente en el contenido proporcionado.

IMPORTANTE:
- El ejercicio debe ser completamente diferente y creativo.
- COMPARA el nuevo ejercicio con CADA UNO de los ejercicios anteriores proporcionados arriba.
- No repitas el mismo concepto principal que ya haya sido utilizado.
- No repitas una pregunta aunque cambies ligeramente las palabras.
- No repitas una situación, caso práctico o aplicación ya utilizada.
- No generes otro ejercicio que pueda responderse prácticamente con la misma información que uno anterior.
- Si un tema ya aparece en los ejercicios anteriores, busca otro concepto diferente dentro del contenido.
- Si no puedes crear un ejercicio realmente diferente, elige otro apartado del contenido.
- Si un ejercicio anterior trata un concepto concreto, utiliza otro concepto o aplicación del contenido.
- No hagas una simple modificación de palabras de un ejercicio anterior.
- El nuevo ejercicio debe poder distinguirse claramente de TODOS los ejercicios anteriores.
- El nuevo ejercicio debe plantear una situación, pregunta o enfoque diferente.
- No repitas preguntas, enunciados ni situaciones típicas.
- Evita hacer siempre preguntas de definición.
- Varía el tipo de ejercicio.
- Puedes plantear casos prácticos, situaciones profesionales, análisis de decisiones, aplicación de conceptos, detección de errores, comparación de estrategias, pequeños casos empresariales o resolución de problemas.
- Haz que el alumno tenga que aplicar lo aprendido, no simplemente copiar una frase del contenido.
- Utiliza únicamente información que aparezca en el contenido.
- La solución debe responder exactamente al ejercicio planteado.
- No repitas el enunciado como solución.
- Si el ejercicio necesita que el alumno lea un párrafo, fragmento o texto concreto para responder, DEBES incluir ese contenido dentro del propio enunciado.
- Nunca escribas frases como "del siguiente párrafo" o "según el texto" si el párrafo o texto no aparece inmediatamente dentro del enunciado.
- El alumno debe poder resolver el ejercicio viendo únicamente el enunciado.

El campo "titulo" debe ser corto, específico y describir exactamente qué se trabaja en el ejercicio.

Nunca uses títulos genéricos como "Título del ejercicio", "Ejercicio 1", "Pregunta 1" o "Actividad".

Ejemplos de títulos válidos:
- "Límites del carnet A2"
- "Requisitos para obtener el carnet A2"
- "Potencia máxima permitida en el A2"

Devuelve SOLO un JSON válido con este formato:

{
  "ejercicio": {
    "titulo": "Límites del carnet A2",
    "enunciado": "Enunciado completo y específico",
    "solucion": "Respuesta correcta y concreta",
    "tipo": "respuesta_abierta",
    "dificultad": "facil",
    "xp": 10
  }
}

Usa:
- facil: 10 XP
- media: 20 XP
- dificil: 30 XP

No inventes información que no aparezca en el contenido.
`

    const respuestaOllama = await fetch(
      'http://localhost:11434/api/generate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.IA_MODELO || 'llama-3.3-70b-versatile',
          prompt,
          stream: false,
          format: 'json',
          options: {
            temperature: 0.2,
          },
        }),
      },
    )

    if (!respuestaOllama.ok) {
      throw new Error(
        `El servicio de IA respondió con ${respuestaOllama.status}`,
      )
    }

    const datos = await respuestaOllama.json()
    const textoRespuesta = datos.response || datos.choices?.[0]?.message?.content || ''
    const ejercicio = JSON.parse(textoRespuesta)

    console.log('EJERCICIO NUEVO GENERADO:', ejercicio)

    res.json(ejercicio)
  } catch (error) {
    console.error('Error generando un ejercicio:', error)

    res.status(500).json({
      error: 'No se ha podido generar el ejercicio.',
    })
  }
})

app.post('/generar-ejercicios', async (req, res) => {
  try {
    const { texto, ejerciciosAnteriores } = req.body

    if (!texto) {
      return res.status(400).json({
        error: 'No se ha recibido texto.',
      })
    }

    const prompt = `
Eres profesor de Formación Profesional de Marketing y Publicidad.

A partir del siguiente contenido de estudio, crea 5 ejercicios para que un alumno pueda practicar.${instruccionDificultad(req.body.dificultad)}

CONTENIDO:
${texto}

EJERCICIOS ANTERIORES QUE NO DEBES REPETIR:
${JSON.stringify(ejerciciosAnteriores ?? [])}

Los ejercicios deben basarse únicamente en el contenido proporcionado.

No repitas ninguno de los ejercicios anteriores indicados arriba.
Cada ejercicio debe utilizar un enfoque o situación diferente.

Devuelve SOLO un JSON válido con este formato:

{
  "ejercicios": [
    {
      "titulo": "Título específico relacionado con el ejercicio",
      "enunciado": "Enunciado completo del ejercicio",
      "solucion": "Respuesta correcta y concreta al ejercicio",
      "tipo": "respuesta_abierta",
      "dificultad": "facil",
      "xp": 20
    }
  ]
}

Genera exactamente 5 ejercicios.
`

    const respuestaOllama = await fetch(
      'http://localhost:11434/api/generate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.IA_MODELO || 'llama-3.3-70b-versatile',
          prompt,
          stream: false,
          format: 'json',
          options: {
            temperature: 0.2,
          },
        }),
      },
    )

    if (!respuestaOllama.ok) {
      throw new Error(
        `El servicio de IA respondió con ${respuestaOllama.status}`,
      )
    }

    const datos = await respuestaOllama.json()
    const textoRespuesta = datos.response || datos.choices?.[0]?.message?.content || ''
    const ejercicios = JSON.parse(textoRespuesta)

    console.log('EJERCICIOS GENERADOS:', ejercicios)

    res.json(ejercicios)
  } catch (error) {
    console.error('Error generando ejercicios:', error)

    res.status(500).json({
      error: 'No se han podido generar los ejercicios.',
    })
  }
})

app.post('/generar-ejercicio-refuerzo', async (req, res) => {
  try {
    const { texto, ejerciciosFallados, ejerciciosAnteriores } = req.body

    if (
      !texto ||
      !Array.isArray(ejerciciosFallados) ||
      ejerciciosFallados.length === 0
    ) {
      return res.status(400).json({
        error: 'Faltan datos para generar el ejercicio de refuerzo.',
      })
    }

    const prompt = `
Eres profesor de Formación Profesional de Marketing y Publicidad.

Un alumno ha fallado varias veces los ejercicios que aparecen abajo.
Tu tarea es crear UN SOLO ejercicio de REFUERZO para que practique ese mismo punto débil.

CONTENIDO DE ESTUDIO:
${texto}

EJERCICIOS QUE EL ALUMNO HA FALLADO:
${JSON.stringify(ejerciciosFallados)}

EJERCICIOS YA EXISTENTES:
${JSON.stringify(ejerciciosAnteriores ?? [])}

Devuelve SOLO un JSON válido con este formato:

{
  "ejercicio": {
    "titulo": "Título corto y específico",
    "enunciado": "Enunciado completo",
    "solucion": "Respuesta correcta y concreta",
    "tipo": "respuesta_abierta",
    "dificultad": "facil",
    "xp": 10
  }
}
`

    const respuestaOllama = await fetch(
      'http://localhost:11434/api/generate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.IA_MODELO || 'llama-3.3-70b-versatile',
          prompt,
          stream: false,
          format: 'json',
          options: {
            temperature: 0.3,
          },
        }),
      },
    )

    if (!respuestaOllama.ok) {
      throw new Error(
        `El servicio de IA respondió con ${respuestaOllama.status}`,
      )
    }

    const datos = await respuestaOllama.json()
    const textoRespuesta = datos.response || datos.choices?.[0]?.message?.content || ''
    const resultado = JSON.parse(textoRespuesta)

    const ejercicio = resultado.ejercicio ?? resultado

    if (!ejercicio || !ejercicio.enunciado || !ejercicio.solucion) {
      throw new Error('La IA devolvió un ejercicio incompleto.')
    }

    console.log('EJERCICIO DE REFUERZO GENERADO:', ejercicio)

    res.json({ ejercicio })
  } catch (error) {
    console.error('Error generando ejercicio de refuerzo:', error)

    res.status(500).json({
      error: 'No se ha podido generar el ejercicio de refuerzo.',
    })
  }
})

app.post('/explicar-concepto', async (req, res) => {
  try {
    const { texto, enunciado } = req.body

    if (!texto || !enunciado) {
      return res.status(400).json({
        error: 'Faltan datos para explicar el concepto.',
      })
    }

    const prompt = `
Eres un profesor de Formación Profesional de Marketing y Publicidad que explica con paciencia.

Un alumno ha fallado varias veces este ejercicio:
${enunciado}

CONTENIDO DE ESTUDIO:
${texto}

Explícale el concepto siguiendo EXACTAMENTE este formato de texto (sin JSON, sin markdown, sin asteriscos):

CONCEPTO:
(el concepto clave en una frase corta)

EXPLICACIÓN:
(2 o 3 frases sencillas)

EJEMPLO:
(un ejemplo corto y real)

EN UNA FRASE:
(la idea que debe recordar)
`

    const respuestaOllama = await fetch(
      'http://localhost:11434/api/generate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.IA_MODELO || 'llama-3.3-70b-versatile',
          prompt,
          stream: false,
          options: {
            temperature: 0.3,
          },
        }),
      },
    )

    if (!respuestaOllama.ok) {
      throw new Error(
        `El servicio de IA respondió con ${respuestaOllama.status}`,
      )
    }

    const datos = await respuestaOllama.json()
    const textoRespuesta = datos.response || datos.choices?.[0]?.message?.content || ''

    res.json({
      explicacion: String(textoRespuesta || '').trim(),
    })
  } catch (error) {
    console.error('Error explicando el concepto:', error)

    res.status(500).json({
      error: 'No se ha podido explicar el concepto.',
    })
  }
})

function seleccionarFragmentos(texto, pregunta, general, maxCaracteres = 4000) {
  const limpio = String(texto || '').replace(/\s+/g, ' ').trim()

  if (limpio.length <= maxCaracteres) {
    return limpio
  }

  const tamano = 800
  const fragmentos = []

  for (let i = 0; i < limpio.length; i += tamano) {
    fragmentos.push({
      indice: fragmentos.length,
      texto: limpio.slice(i, i + tamano),
    })
  }

  if (general) {
    const cuantos = Math.max(1, Math.floor(maxCaracteres / tamano))
    const paso = fragmentos.length / cuantos
    const elegidos = []

    for (let i = 0; i < cuantos; i++) {
      elegidos.push(fragmentos[Math.floor(i * paso)].texto)
    }

    return elegidos.join('\n...\n')
  }

  const normalizar = (t) =>
    t
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')

  const palabrasPregunta = new Set(
    normalizar(String(pregunta || ''))
      .split(' ')
      .filter((palabra) => palabra.length > 3),
  )

  const puntuados = fragmentos
    .map((fragmento) => ({
      ...fragmento,
      puntos: normalizar(fragmento.texto)
        .split(' ')
        .filter((palabra) => palabrasPregunta.has(palabra)).length,
    }))
    .sort((a, b) => b.puntos - a.puntos)

  const elegidos = []
  let total = 0

  for (const fragmento of puntuados) {
    if (total + fragmento.texto.length > maxCaracteres) {
      break
    }

    elegidos.push(fragmento)
    total += fragmento.texto.length
  }

  return elegidos
    .sort((a, b) => a.indice - b.indice)
    .map((fragmento) => fragmento.texto)
    .join('\n...\n')
}

app.post('/chat', async (req, res) => {
  try {
    const { mensajes, contexto, nombreTema, perfil, general } = req.body

    if (!Array.isArray(mensajes) || mensajes.length === 0) {
      return res.status(400).json({
        error: 'No se han recibido mensajes.',
      })
    }

    const ultimaPregunta = mensajes[mensajes.length - 1].texto || ''

    const fragmentos = contexto
      ? seleccionarFragmentos(contexto, ultimaPregunta, general)
      : ''

    const instrucciones = `
Eres el tutor personal de Kandeh, un estudiante de Grado Superior de Marketing y Publicidad.

Responde en el idioma en que te escriba el alumno (español o catalán), con un tono cercano, claro y motivador.
Explica con palabras sencillas y ejemplos reales.
Sé breve: unas 150 palabras como máximo.
No uses markdown ni asteriscos. Usa texto plano y guiones para las listas.
${
  fragmentos
    ? `
MATERIAL DE ESTUDIO DEL TEMA "${nombreTema}":
${fragmentos}
`
    : 'No hay ningún tema seleccionado.'
}
${perfil ? `DATOS DEL ALUMNO:\n${perfil}` : ''}
`

    const mensajesOllama = [
      { role: 'system', content: instrucciones },
      ...mensajes.slice(-8).map((mensaje) => ({
        role: mensaje.rol === 'ia' ? 'assistant' : 'user',
        content: String(mensaje.texto || ''),
      })),
    ]

    const respuestaOllama = await fetch(
      'http://localhost:11434/api/chat',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.IA_MODELO || 'llama-3.3-70b-versatile',
          messages: mensajesOllama,
          options: {
            temperature: 0.4,
          },
        }),
      },
    )

    if (!respuestaOllama.ok) {
      throw new Error(
        `El servicio de IA respondió con ${respuestaOllama.status}`,
      )
    }

    const datos = await respuestaOllama.json()
    const textoRespuesta = datos.message?.content || datos.response || ''

    res.json({
      respuesta: String(textoRespuesta).trim(),
    })
  } catch (error) {
    console.error('Error en el chat:', error)

    res.status(500).json({
      error: 'No se ha podido responder.',
    })
  }
})

app.post('/generar-flashcards', async (req, res) => {
  try {
    const { texto, cantidad } = req.body

    if (!texto) {
      return res.status(400).json({
        error: 'No se ha recibido texto.',
      })
    }

    const total = Number(cantidad) || 8
    const fragmentos = seleccionarFragmentos(texto, '', true, 3500)

    const prompt = `
Eres profesor de Formación Profesional de Marketing y Publicidad.

A partir del siguiente contenido de estudio, crea ${total} flashcards (tarjetas de estudio) en formato JSON estricto.

CONTENIDO:
${fragmentos}

Devuelve SOLO un JSON válido con este formato:
{
  "flashcards": [
    {
      "pregunta": "Pregunta clara",
      "respuesta": "Respuesta concisa"
    }
  ]
}
`

    const respuestaOllama = await fetch(
      'http://localhost:11434/api/generate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.IA_MODELO || 'llama-3.3-70b-versatile',
          prompt,
          stream: false,
          format: 'json',
          options: {
            temperature: 0.3,
          },
        }),
      },
    )

    if (!respuestaOllama.ok) {
      throw new Error(
        `El servicio de IA respondió con ${respuestaOllama.status}`,
      )
    }

    const datos = await respuestaOllama.json()
    const textoRespuesta = datos.response || datos.choices?.[0]?.message?.content || ''
    const resultado = JSON.parse(textoRespuesta)

    res.json(resultado)
  } catch (error) {
    console.error('Error generando flashcards:', error)

    res.status(500).json({
      error: 'No se han podido generar las flashcards.',
    })
  }
})

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`)
})