# Draft: asking USA Fencing for permission to read the member portal on a schedule

Send from the family account. Suggested recipient: the membership / technology contact
listed on usafencing.org (Contact Us), with "Data request — family training app" in the
subject. Fill in the bracketed parts before sending.

---

**Subject:** Permission to read public ranking and results pages for a family fencing app

Hello,

I am a fencing parent in the Orange Coast division. My two sons fence foil (Y12 and Y14 /
Cadet), and over the past year I have built a small web app for our family called En Garde. It
is a training journal and season planner: bouts, lessons, goals, and a plan for which
tournaments to enter and what they will cost.

Part of it reads the public pages on member.usafencing.org that any parent already reads by
hand: the national points pages (for example /points/national/MF/Y14), the ranking pages, a
tournament's event list with entrant counts, and an event's posted results. The app reads a page
only when a parent presses a button, one page at a time, with an identifying user agent
(`EnGardeInsight/1.0`), and keeps a cached copy so it does not read the same page twice in a day.

I noticed that robots.txt on the member portal disallows automated access, so I have kept every
read manual and on request. I am writing to ask two things:

1. Whether reading these public pages on request, as described, is acceptable to USA Fencing.
2. Whether USA Fencing would allow a light scheduled read (once a day at most, a handful of
   pages, identified user agent) so that families see their standing and entry counts without
   pressing a button, or whether there is an official data feed or API you would prefer we use.

A few fencing families at our club have asked to use the app, and I would like to offer it to
them free. Before I do, I want to be sure we are reading your pages the way you would want. I am
happy to change the user agent, the frequency, the pages read, or to stop reading any page you
name. I am also happy to share the source of the reader.

Thank you for the work you do for the sport, and for your time.

[Name]
[Club], Orange Coast division
[Phone] · [Email]
