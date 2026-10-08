import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Subject {
  id: number
  nombre: string
  temasPendientes: number
}

interface SubjectListProps {
  setAsignaturaSeleccionada: (
    id: number,
    nombre: string,
  ) => void
  setPantalla: (pantalla: string) => void
}

function SubjectList({
  setAsignaturaSeleccionada,
  setPantalla,
}: SubjectListProps) {
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    cargarAsignaturas()
  }, [])

  async function cargarAsignaturas() {
    setCargando(true)
    setError(null)

   const { data, error } = await supabase
  .from('asignaturas')
  .select('id, nombre')
  .order('id', { ascending: true })

if (error) {
  console.error('Error cargando asignaturas:', error)

  setError(
    'No se han podido cargar las asignaturas.',
  )

  setCargando(false)
  return
}

const { data: temasData, error: temasError } =
  await supabase
    .from('temas')
    .select('id, asignatura_id')

if (temasError) {
  console.error(
    'Error cargando temas:',
    temasError,
  )

  setError(
    'No se han podido cargar los temas.',
  )

  setCargando(false)
  return
}

const asignaturasConTemas = (data ?? []).map(
  (asignatura) => ({
    id: asignatura.id,
    nombre: asignatura.nombre,
    temasPendientes: (temasData ?? []).filter(
      (tema) =>
        tema.asignatura_id === asignatura.id,
    ).length,
  }),
)

setSubjects(asignaturasConTemas)
    setCargando(false)
  }

  function seleccionarAsignatura(
    id: number,
    nombre: string,
  ) {
    setAsignaturaSeleccionada(id, nombre)
    setPantalla('assignatura')
  }

  return (
    <section>
      <h2>Assignatures</h2>

      <p>
        Aquí trobaràs totes les assignatures del teu cicle.
      </p>

      {cargando && (
        <p>
          Carregant assignatures...
        </p>
      )}

      {error && (
        <div>
          <p>{error}</p>

          <button onClick={cargarAsignaturas}>
            Tornar a intentar
          </button>
        </div>
      )}

      {!cargando && !error && (
        <div className="subjects-list">
          {subjects.map((subject) => (
            <article
              className="subject-card"
              key={subject.id}
              onClick={() =>
                seleccionarAsignatura(
                  subject.id,
                  subject.nombre,
                )
              }
            >
              <h3>{subject.nombre}</h3>

              <p>
                Progrés: 0%
              </p>

              <p>
  Temes pendents: {subject.temasPendientes}
</p>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

export default SubjectList