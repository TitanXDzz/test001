# 0.2.2 Measurable Threshold Table

## Purpose
This document formalizes numeric and semi-numeric escalation thresholds for Symtra.

## Threshold Rules

| Symptom / Sign | Threshold | Minimum Action |
|---|---|---|
| Fever | >= 38.5°C | SEEK_HELP_SOON |
| High fever | >= 39.0°C | SEEK_HELP_SOON |
| Very high fever + weakness/confusion | >= 39.0°C with systemic symptoms | SEEK_HELP_IMMEDIATELY |
| Fever duration | >= 3 days | SEEK_HELP_SOON |
| Persistent vomiting | >= 3 episodes in 24h or unable to keep fluids down | SEEK_HELP_IMMEDIATELY |
| Diarrhea frequency | >= 6 loose stools in 24h | SEEK_HELP_SOON |
| Severe diarrhea + dehydration signs | frequent diarrhea + dizziness / very low urine | SEEK_HELP_IMMEDIATELY |
| Nosebleed duration | > 20 minutes | SEEK_HELP_IMMEDIATELY |
| Heavy bleeding | soaking / continuous bleeding / large-volume bleeding | SEEK_HELP_IMMEDIATELY |
| Pain severity | >= 7/10 | SEEK_HELP_SOON |
| Pain severity | >= 9/10 | SEEK_HELP_IMMEDIATELY |
| Shortness of breath severity | unable to speak full sentences / breathless at rest | SEEK_HELP_IMMEDIATELY |
| Oxygen saturation (if available) | < 94% | SEEK_HELP_IMMEDIATELY |
| Heart rate (if available) | > 120 at rest with concerning symptoms | SEEK_HELP_IMMEDIATELY |
| Dehydration | almost no urine for >= 8 hours | SEEK_HELP_IMMEDIATELY |
| Abdominal pain duration | persistent severe focal pain > 6 hours | SEEK_HELP_IMMEDIATELY |

## Parsing Guidance
The system should support:
- direct numeric input (e.g. "39.2C")
- approximate text input (e.g. "very high fever", "pain 8/10")
- duration phrases (e.g. "for 4 days", "all day", "since yesterday")

## Safety Rule
If the user gives both text and numeric severity, use the worse interpretation.
