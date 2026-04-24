"""Run once to backfill new fields into Firestore bin documents.

This script is idempotent: it can be executed multiple times safely.
"""

import firebase_admin
from firebase_admin import credentials, firestore


DEFAULT_FIELDS = {
    "ultrasonic_cm": 0,
    "waste_composition": {"recyclable": 0, "organic": 0, "hazardous": 0},
    "last_classification": None,
    "alert_triggered": False,
    "image_url": None,
}


def get_db():
    cred = credentials.Certificate("serviceAccountKey.json")
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    return firestore.client()


def backfill_bins_schema(db):
    bins_collection = db.collection("bins")
    docs = list(bins_collection.stream())

    if not docs:
        # Create a starter doc so first-time projects don't fail silently.
        bins_collection.document("KLA-01").set(
            {
                "label": "KLA-01",
                "level": 0,
                "lat": 0.3476,
                "lng": 32.5825,
                "status": "OK",
                **DEFAULT_FIELDS,
            },
            merge=True,
        )
        print("Created starter bin doc: KLA-01")
        return

    updated = 0
    for doc in docs:
        bins_collection.document(doc.id).set(
            {"label": doc.id, **DEFAULT_FIELDS},
            merge=True,
        )
        updated += 1

    print(f"Schema backfill complete. Updated {updated} bin document(s).")


if __name__ == "__main__":
    database = get_db()
    backfill_bins_schema(database)