import OpenAI from 'openai';

const profileSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    profile_id: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    name: { type: ['string', 'null'] },
    location: { type: ['string', 'null'] },
    role: { type: ['string', 'null'] },
    age: { type: ['number', 'null'] },
    gender: { type: ['string', 'null'], enum: ['Male', 'Female', 'Other', null] },
    workExperience: { type: ['string', 'null'], enum: ['Worked before', 'Fresher', null] },
    workExperienceYears: { type: ['string', 'null'] },
    highestQualification: { type: ['string', 'null'] },
    natureOfJobsInterestedIn: {
      type: ['string', 'null'],
      enum: ['Full-time', 'Part-time', 'Any', null],
    },
  },
  required: [
    'profile_id', 'phone', 'name', 'location', 'role', 'age', 'gender',
    'workExperience', 'workExperienceYears', 'highestQualification', 'natureOfJobsInterestedIn',
  ],
};

function buildPrompt({ uuid, contact_id, phone, transcript_text }) {
  return `You are analyzing a call transcript from "Kaam Ki Baat", a voice AI helping Indian workers find jobs. The conversation may be in Hindi, Hinglish, Kannada, or English.

Extract ONLY profile fields explicitly stated by the user in this call. Return null for anything not stated. Do not infer.

INPUT:
- Call UUID: ${uuid}
- Profile ID: ${contact_id}
- Phone: ${phone}
- Transcript: ${transcript_text}

FIELDS (return null if not stated):
1. name — user stated their name
2. location — city/area, translate to standard English (e.g. "हुबली" → "Hubballi")
3. role — job role; if user said "anything" → "Any"
4. age — explicit number only
5. gender — "Male"/"Female"/"Other" only if explicitly stated
6. workExperience — "Worked before"/"Fresher" only if explicitly stated
7. workExperienceYears — number as string e.g. "5"
8. highestQualification — translate to English (ITI / 12th / Graduate etc.)
9. natureOfJobsInterestedIn — "Full-time"/"Part-time"/"Any" only if explicitly stated

Also include:
- profile_id: ${contact_id}
- phone: ${phone}

Output valid JSON only.`;
}

const MUTABLE_FIELDS = [
  'name', 'location', 'role', 'age', 'gender',
  'workExperience', 'workExperienceYears', 'highestQualification', 'natureOfJobsInterestedIn',
];

export async function taskB_profile(payload) {
  const body = payload?.body ?? {};
  const uuid = body.uuid;
  const contact_id = body.contact_id;
  const phone = body.contact_phone || body.to_number || '';
  const transcript = Array.isArray(body.call_transcript) ? body.call_transcript : [];
  const transcript_text = transcript.map((t) => t?.content ?? '').join(' ');

  if (!transcript_text || transcript_text.length < 10) {
    console.log(`Skipping profile extraction for ${uuid}: transcript too short`);
    return;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildPrompt({ uuid, contact_id, phone, transcript_text }) },
      { role: 'user', content: 'Extract the fields now.' },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'ProfilePatch', strict: true, schema: profileSchema },
    },
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned empty content for profile');
  const p = JSON.parse(content);

  const updateable = {};
  for (const k of MUTABLE_FIELDS) {
    if (p[k] !== null && p[k] !== undefined && p[k] !== '') {
      updateable[k] = p[k];
    }
  }

  if (Object.keys(updateable).length === 0) {
    console.log(`No profile updates captured for call ${uuid}`);
    return;
  }

  const res = await fetch(process.env.UPDATE_PROFILE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.UPDATE_PROFILE_API_KEY,
    },
    body: JSON.stringify({
      sourceService: 'ONESTAGENT',
      eventType: 'UPDATE_PROFILE',
      payload: {
        profileId: contact_id,
        phone,
        ...updateable,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Profile update API returned ${res.status}: ${text.slice(0, 500)}`);
  }
}
