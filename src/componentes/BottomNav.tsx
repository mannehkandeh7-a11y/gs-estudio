interface BottomNavProps {
  pantalla: string
  setPantalla: (pantalla: string) => void
}

function BottomNav({ pantalla, setPantalla }: BottomNavProps) {
  return (
    <nav>
      <button
        onClick={() => setPantalla('inicio')}
        disabled={pantalla === 'inicio'}
      >
        Inici
      </button>

      <button
        onClick={() => setPantalla('assignatures')}
        disabled={pantalla === 'assignatures'}
      >
        Assignatures
      </button>

      <button
        onClick={() => setPantalla('ia')}
        disabled={pantalla === 'ia'}
      >
        IA
      </button>

      <button
        onClick={() => setPantalla('progres')}
        disabled={pantalla === 'progres'}
      >
        Progrés
      </button>
    </nav>
  )
}

export default BottomNav