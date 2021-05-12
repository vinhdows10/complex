const express = require("express");
const router = express.Router();
const dbConn = require("../db.js");
const validator = require("express-validator");
const crypto = require("crypto");
const path = require("path");

router.post("/", async function(req, res, next) {
	// TODO: Check session, ensure user is logged in

	let file = req.files.image;
	if (file !== undefined && (file.mimetype == 'image/png' || file.mimetype == 'image/jpeg')) {
        // extension are stripped, mimetype checking should be sufficient
		// generate a random UUID filename and move it to the destination
		let uuid = crypto.randomUUID()
		let new_path = path.join(process.env.UPLOAD_DIR, uuid);

		let err = await file.mv(new_path);

		if (err) {
			console.log("ERROR: " + err);
		}
		console.log(`Saved ${file.name} to ${new_path}`);

		res.send({
			success: 1, uuid: uuid
		});
	} else {
		res.send({
            success: 0, msg: "Invalid File"
		});
	}
});

module.exports = router;
