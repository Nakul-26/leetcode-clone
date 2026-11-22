import mongoose from 'mongoose';

// One-time (idempotent) migration: stamps a collegeId onto every existing document that
// predates the tenant-scoping work (C2 in docs/plans/PLATFORM_AUDIT_AND_SAAS_ROADMAP.md), and
// creates the College row that anchors it if one doesn't exist yet. Safe to re-run: every
// update only targets documents where collegeId is still unset.
//
// Usage: MONGO_URI=... node scripts/backfill_college_id.mjs [--slug=default] [--name="Default College"]

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/assessment_db';

function argValue(flag, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.split('=').slice(1).join('=') : fallback;
}

async function main() {
  const slug = argValue('slug', 'default');
  const name = argValue('name', 'Default College');

  await mongoose.connect(MONGO_URI, { dbName: 'assessment_db', serverSelectionTimeoutMS: 10000 });
  console.log('Connected to MongoDB');

  const colleges = mongoose.connection.collection('colleges');
  const users = mongoose.connection.collection('users');
  const questions = mongoose.connection.collection('questions');
  const assessments = mongoose.connection.collection('assessments');
  const assessmentAttempts = mongoose.connection.collection('assessmentattempts');
  const submissions = mongoose.connection.collection('submissions');

  let college = await colleges.findOne({ slug });
  if (!college) {
    const now = new Date();
    const result = await colleges.insertOne({ name, slug, createdAt: now, updatedAt: now });
    college = { _id: result.insertedId, name, slug };
    console.log(`Created College "${name}" (${slug}):`, college._id.toString());
  } else {
    console.log(`Using existing College "${college.name}" (${slug}):`, college._id.toString());
  }

  const collegeId = college._id;
  const unset = { $or: [{ collegeId: { $exists: false } }, { collegeId: null }] };

  const results = {};
  results.users = await users.updateMany(
    { ...unset, role: { $ne: 'superadmin' } },
    { $set: { collegeId } }
  );
  results.questions = await questions.updateMany(unset, { $set: { collegeId } });
  results.assessments = await assessments.updateMany(unset, { $set: { collegeId } });
  results.assessmentAttempts = await assessmentAttempts.updateMany(unset, { $set: { collegeId } });
  results.submissions = await submissions.updateMany(unset, { $set: { collegeId } });

  for (const [collectionName, result] of Object.entries(results)) {
    console.log(`${collectionName}: matched ${result.matchedCount}, modified ${result.modifiedCount}`);
  }

  console.log('Backfill complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
