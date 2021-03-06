const express = require("express");
const router = express.Router();
const path = require("path");
const dbConn = require("../db.js");
const validator = require("express-validator");
const bcrypt = require("bcryptjs");
const passport = require("passport");
const { session } = require("passport");
const authenticator = require("../totp-authenticator");
const getCsrfToken = require("../csrf.js").getCsrfToken;
const mailer = require("../mailer.js");
const jwt = require("jwt-simple");
require("dotenv").config({ path: __dirname + "/.env" });
// ! rename the database table to your local one
const user_table = "users";
const { serverDomain, domain } = require("../routes.js");
const MINUTES_GOOD = 20;
// #################################################################################################
//* GET

//Prevent Clickjacking

router.use(function applyXFrame(req, res, next) {
    res.set('X-Frame-Options', 'DENY');
    next(); 
});
router.use(function applyCSP(req, res, next) {
    res.set('Content-Security-Policy', "frame-ancestors 'none';");
    next(); 
});

router.get("/QRCode", async (req, res) => {
	res.json(await authenticator.generateSecretAndQR());
});

router.get("/test", (req, res) => {
	console.log(domain);
	// res.redirect(`${domain}/login`);
	res.status(404).send("404: Not Found");
});

router.get("/verifyEmail/:token", (req, res) => {
	var token = req.params["token"];
	var info = jwt.decode(token, process.env.JWT_SECRET);
	console.log(info);
	dbConn.getConnection((err, db) => {
		if (err) {
			console.log("connection failed", err.message);
			res.json({ success: false, message: err.message });
		} else {
			db.query(`SELECT * FROM ?? WHERE username = ?`, [user_table, info["user"]], (err, user) => {
				if (err) {
					db.release();
					console.log(err.message);
					res.send(err);
					// return done(null, false, { message: "Error occured, please contact the admin." });
				} else {
					// query returns a list of users, but of size 1 because username should be unique
					if (user.length !== 1) {
						db.release();
						res.json({ success: false, message: "Invalid URL" });
					} else {
						if (user[0].verified == false) {
							db.query(
								`UPDATE ?? SET verified = true WHERE username = ?`,
								[user_table, info["user"]],
								(error, user) => {
									db.release();
									if (error) {
										console.log(error);
										res.json({ success: true, message: error });
									} else {
										console.log("Account verified!");
										res.redirect(`${domain}/login`);
									}
								}
							);
						} else {
							console.log("Already verified");
							res.send("Account already verified");
						}
					}
				}
			});
		}
	});
});

validate_password = [
	validator
		.check("pass")
		.isLength({ min: 8, max: 15 })
		.withMessage("Password should be between 8-15 characters long.")
		.matches("[0-9]")
		.withMessage("Password must contain a number.")
		.matches("[A-Z]")
		.withMessage("Password must contain an uppercase letter.")
		.trim()
		.escape(),
	validator
		.check("confirm", "Second password should match the first")
		.custom((value, { req, loc, path }) => {
			if (value !== req.body.pass) {
				// throw error if passwords do not match
				throw new Error("Passwords don't match");
			} else {
				return value;
			}
		}),
]

router.post("/resetPassword", validate_password,
	runAsyncWrapper(async (req, res, next) => {
	( {pass, confirmPass, token } = req.body);
	var info = jwt.decode(token, process.env.JWT_SECRET);

	if (Date.now() > info["expire"] + 60*MINUTES_GOOD*1000) {
		return res.json({success: false, message: "Password link has expired. Please create a new link."});
	}

	const errors = validator.validationResult(req);
	var hash = await bcrypt.hash(pass, 14);

	if (errors.isEmpty()) {
		dbConn.getConnection((err, db) => {
			if (err) {
				console.log("connection failed", err.message);
				return res.json({ success: false, message: err.message });
			}
			db.query(`SELECT passwordHash FROM users WHERE email = ?`, [info["email"]], (err,result) => {

				if (err) {
					console.log(err);
					res.json({ success: false, message: issue });
				}
				else {
					if (result[0]['passwordHash'] === token) {
						db.query(`UPDATE users SET password = ? WHERE email = ?`, [hash, info["email"]], (err, result2) => {
							if (err) {
								
								let issue = err.message;
								console.log(issue);
								// req.flash("danger", err.message);
								res.json({ success: false, message: issue });
								// res.redirect("/user/register");
							} else {
								db.query(`UPDATE users SET passwordHash = null WHERE email = ?`, [info["email"]], (err, result3) => {
									console.log("Successfully changed passsword");
									res.json({success: true, messgae: `Successfully reset password`});
								});
							}
						});
					}
					else {
						console.log("Invalid Token");
						res.json({ success: false, message: "Invalid Token" });
					}
				}
			});

			db.release(); // remember to release the connection when you're done
		});
	} else {
		// incorrect inputs
		console.log(errors.errors);
		res.json({ success: false, message: errors.errors });
	}

}));

validate_2FA = [
	validator
		.check("totp")
		.isLength({ min: 6, max: 6 })
		.withMessage("The code should be 6 characters long.")
		.isNumeric()
		.withMessage("The code should be 6 digits.")
		.trim()
		.escape()
];

router.post("/reset2FA", validate_2FA,
	runAsyncWrapper(async (req, res, next) => {
	( {totp, secretKey, token } = req.body);
	var info = jwt.decode(token, process.env.JWT_SECRET);

	if (Date.now() > info["expire"] + 60*MINUTES_GOOD*1000) {
		return res.json({success: false, message: "2FA reset link has expired. Please create a new link."});
	}

	const errors = validator.validationResult(req);

	if (errors.isEmpty()) {
		if (!authenticator.verifyTOTP(secretKey, totp)) {
			return res.send({ success: false, message: "Invalid Authentication Code." });
		}
		dbConn.getConnection((err, db) => {
			if (err) {
				console.log("connection failed", err.message);
				return res.json({ success: false, message: err.message });
			}
			db.query(`SELECT 2FAHash FROM users WHERE email = ?`, [info["email"]], (err,result) => {

				if (err) {
					console.log(err);
					res.json({ success: false, message: issue });
				}
				else {
					if (result[0]['2FAHash'] === token) {
						db.query(`UPDATE users SET secretKey = ? WHERE email = ?`, [secretKey, info["email"]], (err, result2) => {
							if (err) {
								
								let issue = err.message;
								console.log(issue);
								// req.flash("danger", err.message);
								res.json({ success: false, message: issue });
								// res.redirect("/user/register");
							} else {
								db.query(`UPDATE users SET 2FAHash = null WHERE email = ?`, [info["email"]], (err, result3) => {
									console.log("Successfully changed 2FA secret key");
									res.json({success: true, messgae: `Successfully reset 2FA secret key`});
								});
							}
						});
					}
					else {
						console.log("Invalid Token");
						res.json({ success: false, message: "Invalid Token" });
					}
				}
			});

			db.release(); // remember to release the connection when you're done
		});
	} else {
		// incorrect inputs
		console.log(errors.errors);
		res.json({ success: false, message: errors.errors });
	}

}));

// #################################################################################################
//* DELETE

router.delete("/delete/:id", (req, res) => {
	dbConn.getConnection((err, db) => {
		if (err) {
			console.log("connection failed", err.message);
			res.json({ success: false, message: err.message });
		}

		// find user based on session user_id & verify 6-digit 2FA with secret key
		db.query(`SELECT * FROM ?? WHERE user_id = ?`, [user_table, req.params.id], (err, user) => {
			if (authenticator.verifyTOTP(user[0].secretKey, req.body.totp)) {
				if (user[0].verified) {
					db.query(
						`DELETE FROM ?? WHERE user_id = ?`,
						[user_table, req.params.id],
						(err, result) => {
							if (err) {
								// we can only alert one message at a time for "unique" keys, since db insertion errors only alert 1 at a time
								let issue = err.message;
								console.log(issue);
								res.json({
									success: false,
									message: "Delete request cannot be processed at this time.",
								});
							} else {
								console.log("Successfully deleted user id:", req.params.id);
								killSession(req, res, (res) => {
									res.json({
										success: true,
										message: "Your account has been erased from existence.",
									});
								});
							}
						}
					);
				} else res.json({ success: false, message: "User email is not verified, can't login." });
			} else res.json({ success: false, message: "The time based code is incorrect." });
		});

		db.release(); // remember to release the connection when you're done
	});
});

// #################################################################################################
//* POST
router.post("/logout", (req, res) => {
	console.log(req.body);
	if (req.body.csrfToken !== getCsrfToken(req)) {
		return res.json({ success: false, message: "Invalid CSRF Token" });
	}
	killSession(req, res, (res) => {
		res.json({ success: true });
	});
});

validate_login = [
	validator
		.check("email")
		.isEmail()
		.trim()
		.escape()
		.normalizeEmail()
		.matches("(@(g.)?ucla.edu){1}$")
		.withMessage("This email is not registered with UCLA."),
	validator
		.check("pass")
		.isLength({ min: 8, max: 15 })
		.matches("[0-9]")
		.matches("[A-Z]")
		.withMessage("Password is incorrect.")
		.trim()
		.escape(),
	validator.check("totp", "Invalid Google Authenticator Code").isNumeric().trim().escape(),
];

// limit # times an account password can be guessed
tracker = {};
router.post("/login", validate_login, (req, res, next) => {
	if (req.body.csrfToken !== getCsrfToken(req)) {
		return res.json({ success: false, message: "Invalid CSRF Token" });
	}
	const errors = validator.validationResult(req);
	if (errors.isEmpty()) {
		// check to make sure the input email is not on timeout
		// console.log("Checking attempts. Current tracker:\n", tracker);
		let email = req.body.email.split("@", 1)[0];
		// we should respond, return, and not authenticate IF email is on timeout
		if (email in tracker && tracker[email][1] != null) {
			// a timeout was set, so check to see if it is still in effect
			let timeout = tracker[email][1] - Date.now();
			if (timeout > 0) {
				// still timed out
				res.json({
					success: false,
					message: `Your account has been timed out. Please wait ${Math.round(
						timeout / 1000
					)} seconds before attempting to login.`,
				});
				return;
			} else delete tracker[email]; // timeout over, proceed with authentication
		}

		// if authenticated, redirect to main page, and req.user will have the user_id
		passport.authenticate("local", (err, user, info) => {
			if (err) res.json({ success: false, message: err.message });
			else if (!user) {
				// store the email and incorrect password counts
				// if we reached 5 incorrect attempts, enforce a timeout
				if (email in tracker) {
					// at 3 attempts, set a 1 minute timeout, after which we delete this entry
					// 3 should be the max attempts stored. when already 3 attempts, we shouldn't enter this scope
					tracker[email][0] += 1;
					let val = tracker[email];
					if (val[0] == 3) {
						tracker[email][1] = Date.now() + 60 * 1000;
						res.json({
							success: false,
							message: info.message + " Your account will be timed out for 60 seconds.",
						});
					} else {
						res.json({ success: false, message: info.message + " You have 1 attempt remaining." });
					}
				} else {
					tracker[email] = [1, null];
					res.json({ success: false, message: info.message + " You have 2 attempts remaining." });
				}
			} else {
				// reset tracker upon correct login, in case they only got it wrong 1/2x
				if (email in tracker) delete tracker[email];

				req.login(user, (err) => {
					// at this point, req.user and req.session.passport exists
					if (err) res.json({ success: false, message: err.message });
					req.session.save(() => {
						console.log("Logged in and saving session.", req.sessionID, req.session);
						res.json({ success: true });
					});
				});
			}
		})(req, res, next);
	} else {
		// incorrect inputs
		console.log(errors.errors);
		res.json({ success: false, message: errors.errors });
	}
});

validate_registration = [
	validator
		.check("first", "First name must be 3-15 characters.")
		.isLength({ min: 3, max: 15 })
		.trim()
		.escape(),
	validator
		.check("last", "Last name must be 3-15 characters.")
		.isLength({ min: 3, max: 15 })
		.trim()
		.escape(),
	validator
		.check("email")
		.isEmail()
		.trim()
		.escape()
		.normalizeEmail()
		.matches("(@(g.)?ucla.edu){1}$")
		.withMessage("This email is not registered with UCLA."),
	validator
		.check("username", "Username must be 3-15 characters.")
		.isLength({ min: 3, max: 15 })
		.trim()
		.escape(),
	validator
		.check("pass")
		.isLength({ min: 8, max: 15 })
		.withMessage("Password should be between 8-15 characters long.")
		.matches("[0-9]")
		.withMessage("Password must contain a number.")
		.matches("[A-Z]")
		.withMessage("Password must contain an uppercase letter.")
		.trim()
		.escape(),
	validator
		.check("confirm", "Second password should match the first")
		.custom((value, { req, loc, path }) => {
			if (value !== req.body.pass) {
				// throw error if passwords do not match
				throw new Error("Passwords don't match");
			} else {
				return value;
			}
		}),
	validator
		.check("totp")
		.isLength({ min: 6, max: 6 })
		.withMessage("The code should be 6 characters long.")
		.isNumeric()
		.withMessage("The code should be 6 digits.")
		.trim()
		.escape(),
];

router.post(
	"/registration",
	validate_registration,
	runAsyncWrapper(async (req, res, next) => {
		if (req.body.csrfToken !== getCsrfToken(req)) {
			return res.json({ success: false, message: "Invalid CSRF Token" });
		}
		const errors = validator.validationResult(req);
		if (errors.isEmpty()) {
			({ email, first, last, username, pass, secretKey, totp } = req.body);

			hash = await bcrypt.hash(pass, 14);

			// create new account and store the ENCRYPTED information, only if inputs were valid
			// we store emails up until the @____, because an @g.ucla.edu = @ucla.edu
			let info = {
				legal_name: first + " " + last,
				username: username,
				email: email.split("@", 1)[0], // only store everything up to @
				password: hash,
				secretKey: secretKey,
			};

			if (!authenticator.verifyTOTP(secretKey, totp)) {
				return res.send({ success: false, message: "Invalid Authentication Code." });
			}

			console.log(secretKey);
			dbConn.getConnection((err, db) => {
				if (err) {
					console.log("connection failed", err.message);
					res.json({ success: false, message: err.message });
				}
				// SET ? takes the entire info object created above
				db.query(`INSERT INTO ?? SET ?`, [user_table, info], (err, result) => {
					if (err) {
						// we can only alert one message at a time for "unique" keys, since db insertion errors only alert 1 at a time
						let issue = err.message;
						if (issue.search("username") > -1) issue = "The username is already taken.";
						if (issue.search("'email'") > -1) issue = "This email has already been registered.";

						console.log(issue);
						// req.flash("danger", err.message);
						res.json({ success: false, message: issue });
						// res.redirect("/user/register");
					} else {
						let emailHash = mailer.createVerificationHash(username);
						let URL = `${serverDomain}/user/verifyEmail/${emailHash}`;
						mailer.sendEmail(email, URL);

						console.log("Successfully registered account:", info);
						res.json({ success: true, message: "Account created." });
						// req.flash("success", "Account created");
					}
				});

				db.release(); // remember to release the connection when you're done
			});
		} else {
			// invalid inputs
			console.log(errors.errors);
			res.json({ success: false, message: errors.errors });
		}
	})
);

validate_email = [
	validator
		.check("email")
		.isEmail()
		.trim()
		.escape()
		.normalizeEmail()
		.matches("(@(g.)?ucla.edu){1}$")
		.withMessage("This email is not registered with UCLA.")
]

router.post("/forgotPassword",
			validate_email,
			function(req,res) {
				const errors = validator.validationResult(req);
					if (errors.isEmpty()) {
						({email} = req.body);

						let emailHash = mailer.createPasswordReset(email.split("@", 1)[0]);
						let URL = `${domain}/resetPassword/${emailHash}`;

						dbConn.getConnection((err, db) => {
							if (err) {
								console.log("connection failed", err.message);
								res.json({ success: false, message: err.message });
							}
							// SET ? takes the entire info object created above
							db.query(`UPDATE users SET passwordHash = ? WHERE email = ?`, [emailHash, email.split("@", 1)[0]], (err, result) => {
								if (err || result['changedRows'] === 0) {
									
									if (err) {
										console.log(err)
										return res.json({ success: false, message: err });
									}
									else {
										console.log("Email address not found");
										res.json({ success: false, message: "Email is not associated with Complex. Please create an account." });
									}
									
								} else {
									console.log(result['changedRows']);
									mailer.sendResetPassword(email, URL);
			
									console.log("Resetting Account", email);
									res.json({ success: true, message: "Sent email to reset password." });
									
								}
							});
			
							db.release(); // remember to release the connection when you're done
						});
					} else {
						// incorrect inputs
						console.log(errors.errors);
						res.json({ success: false, message: errors.errors });
					}
			});

router.post("/forgot2FA",
		validate_email,
		function(req,res) {
			const errors = validator.validationResult(req);
				if (errors.isEmpty()) {
					({email} = req.body);

					let emailHash = mailer.createNew2FA(email.split("@", 1)[0]);
					let URL = `${domain}/reset2FA/${emailHash}`;

					dbConn.getConnection((err, db) => {
						if (err) {
							console.log("connection failed", err.message);
							res.json({ success: false, message: err.message });
						}
						// SET ? takes the entire info object created above
						db.query(`UPDATE users SET 2FAHash = ? WHERE email = ?`, [emailHash, email.split("@", 1)[0]], (err, result) => {
							if (err || result['changedRows'] === 0) {
									
								if (err) {
									console.log(err)
									return res.json({ success: false, message: err });
								}
								else {
									console.log("Email address not found");
									res.json({ success: false, message: "Email is not associated with Complex. Please create an account." });
								}
								
							} else {
								console.log(result['changedRows']);
								mailer.sendReset2FA(email, URL);
		
								console.log("Resetting Account", email);
								res.json({ success: true, message: "Sent email to reset secret key for 2FA." });
								
							}
						});

						db.release(); // remember to release the connection when you're done
					});
				} else {
					// incorrect inputs
					console.log(errors.errors);
					res.json({ success: false, message: errors.errors });
				}
});

const vote_table = "user_votes";
const vote_columns = "(user_id, review_id, vote_type)";
router.get("/review/votes", checkAuthentication, function (req, res) {
	dbConn.getConnection((err, db) => {
		if (err) {
			console.log("connection failed", err);
			res.send(err);
			return;
		}
		try {
			db.query(
				`SELECT * FROM ?? WHERE user_id = ?`,
				[vote_table, req.user.user_id],
				(err, rows) => {
					if (err) throw err;
					res.json({ success: true, results: rows });
				}
			);
		} catch (e) {
			res.send({ success: false, error: e });
			throw e;
		} finally {
			db.release(); // release connection back to pool regardless of outcome
		}
	});
});

router.patch("/review/:id/vote", checkAuthentication, function (req, res) {
	// Logged In

	({ vote_type, csrfToken } = req.body);
	if (csrfToken !== getCsrfToken(req)) {
		return res.json({ success: false, message: "Invalid CSRF Token" });
	}

	dbConn.getConnection((err, db) => {
		if (err) {
			console.log("connection failed", err);
			res.send(err);
			return;
		}
		try {
			db.query(
				`SELECT * FROM ?? WHERE user_id = ? AND review_id = ?`,
				[vote_table, req.user.user_id, req.params.id],
				(err, rows) => {
					if (err) throw err;
					console.log(rows);
					if (rows.length == 0) {
						// user never voted for this review yet, insert a new row
						db.query(
							`INSERT INTO ${vote_table} ${vote_columns} VALUES (?)`,
							[[req.user.user_id, req.params.id, vote_type]],
							(err, result) => {
								if (err) throw err;
								res.json({ success: true });
							}
						);
					} else {
						// Update
						db.query(
							`UPDATE ?? SET vote_type = ? WHERE user_id = ? AND review_id = ?`,
							[vote_table, vote_type, req.user.user_id, req.params.id],
							(err, result) => {
								if (err) throw err;
								res.json({ success: true });
							}
						);
					}
				}
			);
		} catch (e) {
			res.send({ success: false, error: e });
			throw e;
		} finally {
			db.release(); // release connection back to pool regardless of outcome
		}
	});
});

// check that req.user is valid before user accesses some URL
function checkAuthentication(req, res, next) {
	// console.log("Checking if user is authenticated", req.sessionID, req.user);
	if (req.isAuthenticated()) {
		return next();
	} else {
		res.json({ success: false, message: "You are not logged in." });
	}
}

// avoids tons of 'try catch' statements for async functions
function runAsyncWrapper(callback) {
	/*
  return async (req, res, next) => {
      callback(req, res, next).catch(next);
  }
  */
	return async (req, res, next) => {
		try {
			await callback(req, res, next);
		} catch (err) {
			console.log(err.message);
			res.send({ success: false, message: "Error with asynchronous registration." });
			next(err);
		}
	};
}

function killSession(req, res, callback) {
	req.logout(); // clears req.user
	req.session.destroy(() => {
		// res.clearCookie(req.session.cookie.id);
		req.session = null;
		callback(res);
	});
}

exports.checkAuthentication = checkAuthentication;
exports.route = router;
