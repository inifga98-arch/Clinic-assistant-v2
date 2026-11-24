"""Synthetic "Historia Clínica" photos for testing Flow A (made-up patients, no clinic branding).

Draws the sections of the clinic's paper form (MI = miembro inferior, 3 pages; MS = miembro
superior, 1 page) with printed labels and handwritten-style answers, plus a blurred, tilted copy
of MI page 1 to test unreadable pages.

    python scripts/make-test-forms.py        # writes test_inputs/ws1_intake/forms/*.jpg

Needs Pillow and Windows fonts (Arial, Segoe Print). Never put a real patient's form in the repo.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent.parent / "test_inputs" / "ws1_intake" / "forms"
FONTS = Path("C:/Windows/Fonts")
W, H = 1240, 1754
INK = (20, 40, 140)

label = ImageFont.truetype(str(FONTS / "arial.ttf"), 24)
label_b = ImageFont.truetype(str(FONTS / "arialbd.ttf"), 26)
title_f = ImageFont.truetype(str(FONTS / "arialbd.ttf"), 34)
hand = ImageFont.truetype(str(FONTS / "segoepr.ttf"), 26)


class Page:
    def __init__(self, title: str):
        self.img = Image.new("RGB", (W, H), (250, 249, 244))
        self.d = ImageDraw.Draw(self.img)
        self.y = 60
        self.d.text((W // 2, self.y), title, font=title_f, fill="black", anchor="mt")
        self.y += 70

    def section(self, text: str):
        self.y += 14
        self.d.text((60, self.y), text, font=label_b, fill="black")
        self.d.line((60, self.y + 32, W - 60, self.y + 32), fill="black", width=2)
        self.y += 46

    def field(self, name: str, value: str = "", x: int = 60, width: int = W - 120, newline: bool = True):
        self.d.text((x, self.y), f"{name}:", font=label, fill="black")
        lx = x + self.d.textlength(f"{name}: ", font=label)
        self.d.line((lx, self.y + 30, x + width, self.y + 30), fill=(120, 120, 120), width=1)
        if value:
            self.d.text((lx + 6, self.y - 8), value, font=hand, fill=INK)
        if newline:
            self.y += 44

    def row(self, *fields: tuple[str, str]):
        width = (W - 120) // len(fields)
        for i, (n, v) in enumerate(fields):
            self.field(n, v, x=60 + i * width, width=width - 20, newline=False)
        self.y += 44

    def table(self, header: list[str], rows: list[list[str]], widths: list[int]):
        x0 = 60
        def line(cells, font, color):
            x = x0
            for c, w in zip(cells, widths):
                self.d.rectangle((x, self.y, x + w, self.y + 40), outline="black", width=1)
                self.d.text((x + 8, self.y + (4 if font is hand else 8)), c, font=font, fill=color)
                x += w
            self.y += 40
        line(header, label_b, "black")
        for r in rows:
            x = x0
            for i, (c, w) in enumerate(zip(r, widths)):
                self.d.rectangle((x, self.y, x + w, self.y + 40), outline="black", width=1)
                font, color = (label, "black") if i == 0 else (hand, INK)
                self.d.text((x + 8, self.y + (8 if i == 0 else 2)), c, font=font, fill=color)
                x += w
            self.y += 40
        self.y += 10

    def save(self, name: str):
        OUT.mkdir(parents=True, exist_ok=True)
        self.img.save(OUT / name, quality=85)
        return self.img


def mi_forms():
    p1 = Page("HISTORIA CLÍNICA MI")
    p1.row(("Fecha", "24/11/2026"), ("Realizó", "Ana Torres"))
    p1.section("FICHA DE IDENTIFICACIÓN")
    p1.row(("Nombre", "Laura Méndez Ruiz"), ("Edad", "35"))
    p1.row(("Fecha de nacimiento", "14/03/1991"), ("Ocupación", "Contadora"))
    p1.row(("Género", "Femenino X"), ("Estado civil", "Soltera"))
    p1.field("Riesgo de caídas", "Bajo")
    p1.row(("Médico", "Dr. Ruiz"), ("Especialidad", "Ortopedia"))
    p1.row(("Contacto de emergencia", "Rosa Méndez"), ("Parentesco", "Madre"))
    p1.field("Tel. emergencia", "55 1111 2222")
    p1.section("AHF (antecedentes heredofamiliares)")
    p1.table(["", "Hermanos", "Madre", "Padre", "Abuelos"],
             [["Cáncer", "", "", "", ""], ["Diabetes", "", "X", "", ""], ["HTA", "", "", "", "X"],
              ["Cardiopatías", "", "", "", ""], ["Infartos/ACV", "", "", "", ""],
              ["Enf. reumáticas", "", "", "", ""], ["Artrosis/otros", "", "", "", ""]],
             [300, 205, 205, 205, 205])
    p1.section("APNP")
    p1.field("Toxicomanías", "Niega")
    p1.row(("Actividad física", "Correr"), ("Frecuencia", "3 x semana"), ("Horas diarias", "1"))
    p1.section("APP")
    p1.row(("Alergias", "Niega"), ("Transfusiones", "Niega"))
    p1.row(("Quirúrgicos", "Niega"), ("Quirúrgicos ortopédicos", "Niega"))
    p1.field("Trauma", "Esguince tobillo izq. jugando fútbol (oct 2026)")
    p1.field("Enfermedades", "Niega")
    p1.field("Medicamentos/suplementos", "Ibuprofeno 400 mg si hay dolor")
    p1.section("SIGNOS VITALES")
    p1.row(("Temp", "36.5"), ("TA", "110/70"), ("FR", "16"), ("SatO2", "98%"), ("FC", "72"))
    page1 = p1.save("mi_p1.jpg")

    p2 = Page("HISTORIA CLÍNICA MI")
    p2.field("MOTIVO DE LA CONSULTA", "Dolor de tobillo izquierdo")
    p2.field("Mecanismo de lesión", "Inversión forzada al caer de un salto")
    p2.section("SEMIOLOGÍA DEL DOLOR")
    p2.row(("Aparición", "Hace 3 semanas"), ("Tipo", "Punzante"))
    p2.field("Localización", "Cara lateral tobillo izquierdo")
    p2.row(("Intensidad", "6/10"), ("Irradiación", "No"))
    p2.field("Aumenta o disminuye con", "Aumenta al caminar, disminuye en reposo")
    p2.section("EXPLORACIÓN FÍSICA")
    p2.field("Postura", "Sin alteraciones")
    p2.field("Marcha", "Claudicante, apoyo reducido izq.")
    p2.section("GONIOMETRÍA (valoración inicial)")
    p2.table(["Tobillo", "Derecha", "Izquierda"],
             [["Flex. dorsal", "20°", "10°"], ["Flex. plantar", "45°", "35°"],
              ["Inversión", "30°", "15°"], ["Eversión", "20°", "10°"]],
             [400, 300, 300])
    p2.section("FUERZA MUSCULAR (MRC)")
    p2.table(["Movimiento", "Derecho", "Izquierdo"],
             [["Eversores", "5", "4"], ["Inversores", "5", "4"], ["Flexores plantares", "5", "4"]],
             [400, 300, 300])
    p2.save("mi_p2.jpg")

    p3 = Page("HISTORIA CLÍNICA MI")
    p3.section("PRUEBAS ORTOPÉDICAS (Positiva/Negativa/Dolorosa)")
    p3.table(["TOBILLO", "Derecho", "Izquierdo"],
             [["Cajón anterior", "Negativa", "Dolorosa"], ["Inclinación talar", "Negativa", "Positiva"],
              ["Squeeze test", "Negativa", "Negativa"], ["Reglas de Ottawa", "Negativa", "Negativa"]],
             [420, 290, 290])
    p3.field("Sensibilidad", "Conservada")
    p3.field("Reflejos", "Normales")
    p3.field("Espasmo o contractura (localización)", "Peroneos izquierdos")
    p3.field("Cicatriz quirúrgica", "")
    p3.field("Edema (localización)", "Maléolo lateral izq.")
    p3.row(("Tipo", "Blando"), ("Signo de Godette", "Negativo"))
    p3.field("Estudios auxiliares", "Radiografía sin fractura")
    p3.field("Impresión diagnóstica", "Esguince de tobillo grado II")
    p3.field("Diagnóstico fisioterapéutico", "Inestabilidad lateral tobillo izq.")
    p3.field("", "con déficit de dorsiflexión")
    p3.section("PLAN DE TRATAMIENTO")
    p3.field("Objetivos", "Recuperar dorsiflexión; volver a correr en 6 semanas")
    p3.field("Indicaciones", "2 sesiones por semana; propiocepción; hielo")
    p3.save("mi_p3.jpg")

    blurred = page1.rotate(3, expand=False, fillcolor=(240, 240, 235)).filter(ImageFilter.GaussianBlur(4))
    blurred.save(OUT / "mi_p1_borrosa.jpg", quality=60)


def ms_form():
    p = Page("HISTORIA CLÍNICA MS")
    p.row(("Fecha", "24/11/2026"), ("Realizó", "Ana Torres"))
    p.row(("Nombre", "Carlos Prueba Ramírez"), ("Edad", "48"))
    p.row(("Fecha de nacimiento", "21/07/1978"), ("Género", "Masculino X"))
    p.row(("Médico", "Dra. Salas"), ("Especialidad", "Ortopedia"))
    p.field("APP Alergias", "Penicilina")
    p.field("MOTIVO DE LA CONSULTA", "Dolor de hombro derecho al elevar el brazo")
    p.row(("Intensidad", "5/10"), ("Aparición", "Hace 2 meses"))
    p.section("GONIOMETRÍA")
    p.table(["Hombro", "Derecha", "Izquierda"],
            [["Flexión", "140°", "175°"], ["ABD", "120°", "170°"], ["Rot. E", "60°", "90°"]], [400, 300, 300])
    p.section("PRUEBAS ORTOPÉDICAS")
    p.table(["HOMBRO", "Derecho", "Izquierdo"],
            [["Test de Hawkins", "Positiva", "Negativa"], ["Jobe", "Dolorosa", "Negativa"]], [420, 290, 290])
    p.field("Impresión diagnóstica", "Tendinopatía del manguito rotador")
    p.field("Diagnóstico fisioterapéutico", "Síndrome subacromial derecho")
    p.field("Objetivos", "Elevar el brazo sin dolor")
    p.field("Indicaciones", "2 sesiones por semana; ejercicio excéntrico")
    p.save("ms_p1.jpg")


if __name__ == "__main__":
    mi_forms()
    ms_form()
    print("wrote", ", ".join(sorted(f.name for f in OUT.glob("*.jpg"))))
