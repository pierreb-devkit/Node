/**
 * @desc Function to parse error message
 * @param {Object} err
 * @return {String} message
 */
const getUniqueMessage = (err) => {
  let output;

  // Primary: derive the field from the driver-supplied keyPattern (e.g. { email: 1 }).
  // This is index-NAME-agnostic, so it works for both the legacy `email_1` index and
  // the E3 case-insensitive `email_ci_unique` collation index — the old errmsg parse
  // below assumed a `{field}_1` index name and broke on any other name (and the
  // collation index's keyValue is binary-garbled, so keyPattern is the right source).
  const keyField = err.keyPattern && typeof err.keyPattern === 'object' ? Object.keys(err.keyPattern)[0] : null;
  if (keyField) {
    return `${keyField.charAt(0).toUpperCase() + keyField.slice(1)} already exists`;
  }

  try {
    let begin = 0;
    if (err.errmsg.lastIndexOf('.$') !== -1) {
      // support mongodb <= 3.0 (default: MMapv1 engine)
      // "errmsg" : "E11000 duplicate key error index: mean-dev.users.$email_1 dup key: { : \"test@user.com\" }"
      begin = err.errmsg.lastIndexOf('.$') + 2;
    } else {
      // support mongodb >= 3.2 (default: WiredTiger engine)
      // "errmsg" : "E11000 duplicate key error collection: mean-dev.users index: email_1 dup key: { : \"test@user.com\" }"
      begin = err.errmsg.lastIndexOf('index: ') + 7;
    }
    const fieldName = err.errmsg.substring(begin, err.errmsg.lastIndexOf('_1'));
    output = `${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} already exists`;
  } catch (_err) {
    output = 'Unique field already exists';
  }

  return output;
};

/**
 * @desc Function to get error message from specific code
 * @param {Object} err
 * @return {String} message
 */
const getMessageFromCode = (err) => {
  let output;
  switch (err.code) {
    case 11001:
      output = getUniqueMessage(err);
      break;
    case 11000:
      output = getUniqueMessage(err);
      break;
    default: {
      if (err.message) output = err.message;
      else output = 'Something went wrong.';
    }
  }
  return output;
};

/**
 * @desc Function to map an array/object of errors
 * @param {Object} err
 * @return {String} message
 */
const getMessageFromErrors = (err) => {
  let output = '';
  if (err.errors instanceof Array) {
    err.errors.forEach((error) => {
      if (error.message) {
        output += `${error.message} `;
      }
    });
  } else if (err.errors instanceof Object) {
    Object.keys(err.errors).forEach((key) => {
      if (err.errors[key].message) {
        output += `${err.errors[key].message} `;
      }
    });
  }
  return output;
};

const cleanMessage = (message) => {
  if (!message || typeof message !== 'string' || !message.trim()) return 'Something went wrong.';
  if (message[message.length - 1] !== '.') return `${message}.`;
  return message;
};

/**
 * @desc Function to route error to specific actio in order to get clean result for api
 * @param {Object} err
 * @return {String} message
 */
const getMessage = (err) => {
  let output = '';
  if (err.code) output = getMessageFromCode(err);
  else if (err.errors) output = getMessageFromErrors(err);
  else if (err.message) output = err.message;
  else output = 'Something went wrong.';
  return cleanMessage(output);
};

export default {
  getMessage,
};
