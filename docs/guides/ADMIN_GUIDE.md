# 🛡️ Admin Guide: Platform Maintenance

This guide is for system administrators responsible for the platform's reliability and security.

## 1. System Monitoring
- Monitor the **System Dashboard** regularly.
- **Queue Depth:** If the number of pending submissions is consistently high, consider adding more Judge worker instances.
- **Health Checks:** Ensure all services (MongoDB, RabbitMQ, Redis, API, Judge) are marked as "Healthy".

## 2. Security & Compliance
- **Audit Logs:** Use the Audit Logs section to track all logins, password resets, and assessment starts. This is your primary tool for investigating disputes.
- **Role Management:** Ensure only trusted personnel have `faculty` or `admin` roles. Use the User Management screen to promote/demote users if necessary.

## 3. Disaster Recovery (Backups)
- The system includes automated backup scripts.
- **Create Backup:** Run `./scripts/backup_db.sh`. This creates a compressed `.gz` archive in the `backups/` folder.
- **Restore Backup:** In case of data loss, run `./scripts/restore_db.sh <filename>`. **Warning:** This will overwrite current data. Always perform a restore test on a staging server first.

## 4. Scaling
- **Vertical Scaling:** Increase CPU and RAM on the main server to handle up to 500 concurrent students.
- **Horizontal Scaling:** Deploy additional instances of `judge-service-go` connecting to the same RabbitMQ queue to handle 1000+ students.

## 5. Adding Problems
- Admins can add new coding problems via the **Add Problem** screen.
- Ensure every problem has:
  - Clear description, function name, and signature (parameters & types).
  - At least 2 sample test cases (visible to students).
  - Several hidden test cases for grading.
  - A reference solution to certify the problem data.
 