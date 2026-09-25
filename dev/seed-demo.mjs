/**
 * Two demo classes in the local Canvas, for walking through the product.
 *
 * Run:  node dev/seed-demo.mjs
 *
 * ── What this is for, and how it differs from the other seeds ─────────
 *
 * `seed.mjs` builds edge cases and `seed-coldwar.mjs` loads a real course at
 * scale. This one is a demo: one student, two ordinary classes, and enough real
 * writing in each that the pipeline has something to read — an ACT profile, and
 * a class window per course with findings worth showing.
 *
 * The work is written to have a shape, because a class window reads patterns
 * across a term. In English the student quotes well and explains less, then
 * explains more after the revision. In Chemistry the numbers are careful and
 * the error analysis is thin. Every item has a due date and a grade, and each
 * class has gradebook items with nothing turned in — participation, a seminar,
 * a quiz on paper — which the class window lists as "No writing to read."
 *
 * Idempotent by name: courses, users and assignments are found rather than
 * duplicated, and a piece already submitted is not submitted again (a second
 * submission would be a second attempt, not a no-op).
 */

import {
  CANVAS,
  api,
  uploadFile,
  findOrCreateUser,
  findOrCreateCourse,
  enrol,
  findOrCreateAssignment,
  submit,
  gradeAndComment,
} from "./canvas.mjs";

const STUDENT_LOGIN = "demo@example.com";
const STUDENT_PASSWORD = "password123";
const STUDENT_NAME = "Jordan Avery";

const enc = (s) => new TextEncoder().encode(s);
const html = (paragraphs) => paragraphs.map((p) => `<p>${p}</p>`).join("");

// ── English 11 ────────────────────────────────────────────────────────────

const ENGLISH = {
  name: "English 11: American Literature",
  code: "ENG-11",
  work: [
    {
      name: "Reading Response: The Crucible, Act I",
      dueAt: "2026-08-28T23:59:00Z",
      points: 10,
      grade: 8,
      comment: "Good quotes. Tell me more about why Abigail's line matters.",
      instructions: "Respond to Act I in 250 words. Use at least two quotations.",
      text: [
        "In Act I of The Crucible, Abigail Williams controls the room by controlling the story. When she tells the other girls, \"Let either of you breathe a word, or the edge of a word, about the other things, and I will come to you in the black of some terrible night,\" she is threatening them, but she is also deciding what the truth will be.",
        "Reverend Parris is more worried about his reputation than about his daughter. He says, \"There is a faction that is sworn to drive me from my pulpit.\" This shows he cares about his position.",
        "The act shows that in Salem, fear spreads faster than facts. Everyone has a reason to want someone else to be guilty.",
      ],
    },
    {
      name: "Close Reading: The Great Gatsby, Chapter 1",
      dueAt: "2026-09-04T23:59:00Z",
      points: 20,
      grade: 16,
      comment: "Strong observation about the green light. Your second paragraph summarises more than it analyses.",
      instructions: "Choose one passage from Chapter 1 and analyse how Fitzgerald uses imagery. 400 words.",
      file: "gatsby-close-reading.txt",
      text: [
        "At the end of Chapter 1, Nick sees Gatsby standing alone on his lawn, reaching toward \"a single green light, minute and far away, that might have been the end of a dock.\" Fitzgerald makes the light small and distant on purpose. Gatsby is a rich man who could have almost anything, but the thing he reaches for is something he cannot touch.",
        "Earlier in the chapter Nick goes to the Buchanans' house. Tom is described as having a \"cruel body\" and Daisy and Jordan are lying on a couch while the curtains blow around. Tom talks about a book about race and Daisy says she hopes her daughter will be \"a beautiful little fool.\" Then Nick goes home.",
        "The imagery of the green light connects to the idea of wanting. The color green could mean money, or it could mean hope. Either way, Fitzgerald shows that Gatsby's desire is bigger than what he has.",
      ],
    },
    {
      name: "Argument Essay: Is the American Dream Still Possible?",
      dueAt: "2026-09-12T23:59:00Z",
      points: 100,
      grade: 84,
      comment: "Clear claim and good sources. Several quotes are dropped in without explanation — what does each one prove?",
      instructions: "Write a 900-word argument essay answering the prompt. Use at least three sources, including one of our novels.",
      file: "american-dream-essay.txt",
      text: [
        "The American Dream is still possible, but it is no longer equally possible for everyone. The idea that anyone who works hard can move up is still true for some people, but where you start now decides much more about where you end up than it did fifty years ago.",
        "According to research by economist Raj Chetty, \"children's chances of earning more than their parents have fallen from 90 percent to 50 percent.\" Also, a 2023 Pew survey found that only about a third of Americans believe their children will be better off than they are.",
        "In The Great Gatsby, Gatsby rebuilds himself from nothing. \"His parents were shiftless and unsuccessful farm people — his imagination had never really accepted them as his parents at all.\" He becomes rich, but he is never accepted by Tom and Daisy's world.",
        "Some people argue that the Dream is still alive because immigrants continue to start businesses at high rates. This is true, and it shows that effort still matters.",
        "In conclusion, the American Dream still exists, but it is harder to reach than it used to be, and it depends a lot on where you begin.",
      ],
    },
    {
      name: "Argument Essay Revision",
      dueAt: "2026-09-19T23:59:00Z",
      points: 100,
      grade: 91,
      comment: "Much better — every source now does work for the argument. The counterargument paragraph is your strongest.",
      instructions: "Revise your argument essay using my comments and one peer review. Submit the full revised essay.",
      file: "american-dream-revision.txt",
      text: [
        "The American Dream is still possible, but it is no longer equally possible for everyone. Hard work still matters, but the starting line now decides much more about the finish than it did fifty years ago.",
        "Raj Chetty's research found that \"children's chances of earning more than their parents have fallen from 90 percent to 50 percent.\" That number matters because it measures exactly what the Dream promises: that each generation can do better than the last. If that is now a coin flip, the promise has changed from a rule into a gamble.",
        "Gatsby shows what the Dream looks like when it works only halfway. He turns himself from the son of \"shiftless and unsuccessful farm people\" into a millionaire, which proves that reinvention is possible. But Tom still calls him \"Mr. Nobody from Nowhere.\" Gatsby can earn the money, but he cannot earn the acceptance, which suggests that the Dream was always about more than income.",
        "Some argue that the Dream is alive because immigrants start businesses at higher rates than people born here. This is a strong point, and it shows that effort still pays off. However, starting a business and staying in the middle class are different things. The same immigrants face the same falling odds for their children that Chetty describes, so the evidence shows the Dream is reachable for individuals while getting less likely across generations.",
        "The American Dream is not dead, but it is no longer a promise. It is a possibility whose odds depend on where you start, and a country that believes in it should care about those odds.",
      ],
    },
    {
      name: "Rhetorical Analysis: Letter from Birmingham Jail",
      dueAt: "2026-09-23T23:59:00Z",
      points: 50,
      grade: 44,
      comment: "You explain King's choices, not just name them. Watch the length of your intro.",
      instructions: "Analyse how King responds to the clergymen's claim that the protests are \"untimely.\" 500 words.",
      text: [
        "The clergymen call the protests \"unwise and untimely,\" and King's whole letter is built to turn that word around. Instead of arguing that the timing is good, he argues that for Black Americans the timing has never been allowed to be good.",
        "He writes, \"For years now I have heard the word 'Wait!' It rings in the ear of every Negro with piercing familiarity. This 'Wait' has almost always meant 'Never.'\" King takes the clergymen's own word and shows what it sounds like to the people who have been hearing it. This works because the reader cannot keep using the word \"untimely\" without hearing \"never\" underneath it.",
        "His long sentence that begins \"when you have seen vicious mobs lynch your mothers and fathers at will\" keeps going for over three hundred words. The length is the point: the reader has to wait through it, the same way King says his people have been made to wait. The structure makes the argument before the sentence even ends.",
        "By the end, King has made \"wait\" sound like the unreasonable position and direct action sound patient.",
      ],
    },
  ],
  // Gradebook items with nothing turned in.
  gradebook: [
    { name: "Participation: Weeks 1–4", points: 10, grade: 9, type: "none" },
    { name: "Socratic Seminar: The Crucible", points: 20, grade: 18, type: "on_paper", dueAt: "2026-09-02T15:00:00Z" },
  ],
};

// ── Chemistry ─────────────────────────────────────────────────────────────

const CHEMISTRY = {
  name: "Chemistry",
  code: "CHEM",
  work: [
    {
      name: "Lab 1: Density of Unknown Metals",
      dueAt: "2026-08-27T23:59:00Z",
      points: 50,
      grade: 45,
      comment: "Careful measurements and correct identifications. Your error section needs a real source of error, not \"human error\".",
      instructions: "Determine the density of three unknown metal samples by water displacement and identify each metal. Include a data table, calculations, and error analysis.",
      file: "lab1-density.txt",
      text: [
        "Purpose: To find the density of three unknown metals and identify them using a table of known densities.",
        "Data: Sample A had a mass of 44.62 g and displaced 5.0 mL of water. Sample B had a mass of 26.95 g and displaced 10.0 mL. Sample C had a mass of 57.10 g and displaced 5.1 mL.",
        "Calculations: Density = mass / volume. Sample A: 44.62 g / 5.0 mL = 8.92 g/mL. Sample B: 26.95 g / 10.0 mL = 2.70 g/mL. Sample C: 57.10 g / 5.1 mL = 11.2 g/mL.",
        "Identification: Sample A is copper (8.96 g/mL), Sample B is aluminum (2.70 g/mL), and Sample C is lead (11.34 g/mL). Percent error for copper: |8.92 − 8.96| / 8.96 × 100 = 0.45%. For lead: |11.2 − 11.34| / 11.34 × 100 = 1.2%.",
        "Error analysis: Our results were very close. Any error was probably due to human error when reading the graduated cylinder.",
      ],
    },
    {
      name: "Problem Set: Stoichiometry",
      dueAt: "2026-09-03T23:59:00Z",
      points: 30,
      grade: 24,
      comment: "Setups are right. Problem 4 is a limiting-reagent problem — you used the wrong reactant.",
      instructions: "Complete problems 1–5. Show every conversion step with units.",
      text: [
        "1. How many grams of water form from 4.0 g of H2? 2H2 + O2 → 2H2O. 4.0 g H2 × (1 mol / 2.02 g) = 1.98 mol H2. 1.98 mol H2 × (2 mol H2O / 2 mol H2) = 1.98 mol H2O × 18.02 g/mol = 35.7 g H2O.",
        "2. How many moles of CO2 come from burning 1.5 mol C3H8? C3H8 + 5O2 → 3CO2 + 4H2O. 1.5 mol × (3 / 1) = 4.5 mol CO2.",
        "3. Mass of NaCl from 10.0 g Na with excess Cl2: 10.0 g / 22.99 g/mol = 0.435 mol Na → 0.435 mol NaCl × 58.44 g/mol = 25.4 g NaCl.",
        "4. 10.0 g of N2 reacts with 3.0 g of H2 (N2 + 3H2 → 2NH3). 10.0 g N2 / 28.02 = 0.357 mol N2 → 0.714 mol NH3 × 17.03 = 12.2 g NH3.",
        "5. Percent yield if 10.0 g NH3 is actually collected in problem 4: 10.0 / 12.2 × 100 = 82%.",
      ],
    },
    {
      name: "Lab 2: Reaction Rates and Temperature",
      dueAt: "2026-09-11T23:59:00Z",
      points: 50,
      grade: 41,
      comment: "Your graph and trend description are excellent. The conclusion claims more than five trials can show.",
      instructions: "Measure how temperature affects the rate of the reaction between sodium thiosulfate and hydrochloric acid. Graph your results and explain them using collision theory.",
      file: "lab2-reaction-rates.txt",
      text: [
        "Hypothesis: If the temperature increases, then the reaction will happen faster, because particles move faster and collide more often.",
        "Data (time for the X to disappear): 20°C — 62 s; 30°C — 41 s; 40°C — 27 s; 50°C — 18 s; 60°C — 12 s.",
        "Graph: Time decreased as temperature increased. The curve is steepest between 20°C and 40°C and levels off after 50°C. Rate (1/time) roughly doubles for every 10°C increase, going from 0.016 s⁻¹ at 20°C to 0.083 s⁻¹ at 60°C.",
        "Explanation: According to collision theory, particles need to collide with enough energy to react. At higher temperatures more particles have that energy, so there are more successful collisions per second.",
        "Conclusion: This proves that temperature always doubles the reaction rate every 10 degrees for all reactions.",
      ],
    },
    {
      name: "Data Analysis: Gas Laws",
      dueAt: "2026-09-18T23:59:00Z",
      points: 30,
      grade: 28,
      comment: "Nicely done — you picked the right law each time and your predictions from the graph are spot on.",
      instructions: "Use the provided data tables to identify which gas law applies to each experiment and make a prediction for the missing value.",
      text: [
        "Table 1 keeps temperature constant while pressure and volume change. As pressure goes from 100 kPa to 200 kPa, volume goes from 4.0 L to 2.0 L. Pressure × volume stays at 400 each time, so this is Boyle's Law. At 250 kPa the volume should be 400 / 250 = 1.6 L.",
        "Table 2 keeps pressure constant. Volume goes from 2.0 L at 273 K to 2.5 L at 341 K. V/T stays about 0.0073, so this is Charles's Law. The line on the graph goes through the origin when temperature is in Kelvin, which is why Celsius would not work. At 400 K the volume should be 0.0073 × 400 = 2.9 L.",
        "Table 3 shows pressure rising with temperature in a sealed rigid container, which is Gay-Lussac's Law. The trend is linear, so extending the line to 373 K predicts a pressure of about 137 kPa.",
      ],
    },
    {
      name: "Lab 3: Acid–Base Titration",
      dueAt: "2026-09-24T23:59:00Z",
      points: 50,
      grade: 43,
      comment: "Accurate endpoint and molarity. You finally named a specific error source — good. Say which direction it would push your result.",
      instructions: "Titrate an HCl solution of unknown concentration with 0.100 M NaOH. Report the molarity of the acid and analyse your error.",
      file: "lab3-titration.txt",
      text: [
        "Purpose: To find the concentration of an HCl solution by titrating it with 0.100 M NaOH.",
        "Data: 25.00 mL of HCl was titrated. Trial 1 used 22.40 mL NaOH, trial 2 used 22.35 mL, and trial 3 used 22.45 mL. The average volume was 22.40 mL.",
        "Calculations: Moles NaOH = 0.100 M × 0.02240 L = 0.00224 mol. The reaction is 1:1, so moles HCl = 0.00224 mol. Molarity of HCl = 0.00224 mol / 0.02500 L = 0.0896 M.",
        "Error analysis: The actual concentration was 0.0900 M, so our percent error was 0.44%. One source of error is overshooting the endpoint, since the pink color appeared and then faded in trial 1. Another is an air bubble in the buret tip at the start.",
      ],
    },
  ],
  gradebook: [
    { name: "Lab Safety Quiz", points: 10, grade: 10, type: "on_paper", dueAt: "2026-08-21T15:00:00Z" },
    { name: "Lab Notebook Check", points: 20, grade: 17, type: "none" },
  ],
};

// ── Seeding ───────────────────────────────────────────────────────────────

async function alreadySubmitted(courseId, assignmentId, studentId) {
  const s = await api(`/courses/${courseId}/assignments/${assignmentId}/submissions/${studentId}`);
  return Boolean(s?.submitted_at);
}

async function seedCourse(spec, student) {
  const course = await findOrCreateCourse(spec.name);
  await api(`/courses/${course.id}`, { method: "PUT", form: { "course[course_code]": spec.code } });
  await enrol(course.id, student.id, "StudentEnrollment");
  console.log(`\nCourse: ${spec.name} (id ${course.id})`);

  for (const item of spec.work) {
    const isUpload = Boolean(item.file);
    const a = await findOrCreateAssignment(course.id, {
      name: item.name,
      description: `<p>${item.instructions}</p>`,
      submissionTypes: [isUpload ? "online_upload" : "online_text_entry"],
      points: item.points,
      dueAt: item.dueAt,
    });

    if (!(await alreadySubmitted(course.id, a.id, student.id))) {
      if (isUpload) {
        const f = await uploadFile({
          name: item.file,
          contentType: "text/plain",
          bytes: enc(item.text.join("\n\n") + "\n"),
          as: student.id,
        });
        await submit(course.id, a.id, student.id, {
          "submission[submission_type]": "online_upload",
          "submission[file_ids][]": f.id,
        });
      } else {
        await submit(course.id, a.id, student.id, {
          "submission[submission_type]": "online_text_entry",
          "submission[body]": html(item.text),
        });
      }
    }
    await gradeAndComment(course.id, a.id, student.id, { grade: item.grade, comment: item.comment });
    console.log(`  ✓ ${item.name} — ${item.grade} / ${item.points}`);
  }

  for (const item of spec.gradebook) {
    const a = await findOrCreateAssignment(course.id, {
      name: item.name,
      submissionTypes: [item.type],
      points: item.points,
      dueAt: item.dueAt,
    });
    await gradeAndComment(course.id, a.id, student.id, { grade: item.grade });
    console.log(`  ✓ ${item.name} — ${item.grade} / ${item.points}, nothing turned in`);
  }
}

async function main() {
  console.log(`Canvas: ${CANVAS}`);
  const student = await findOrCreateUser({
    login: STUDENT_LOGIN,
    name: STUDENT_NAME,
    password: STUDENT_PASSWORD,
  });
  console.log(`Student: ${student.name} (id ${student.id}) — ${STUDENT_LOGIN} / ${STUDENT_PASSWORD}`);

  await seedCourse(ENGLISH, student);
  await seedCourse(CHEMISTRY, student);

  console.log(`
Done.

  Canvas   ${CANVAS}
  Student  ${STUDENT_LOGIN} / ${STUDENT_PASSWORD}

Sign in as the student, open the Ethyra extension and export. Expect two
courses in the manifest, every item with its grade, and the four gradebook
items listed with no files.
`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
