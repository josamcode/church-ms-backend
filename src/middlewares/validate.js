const Joi = require('joi');
const ApiError = require('../utils/ApiError');

const validate = (schema) => (req, res, next) => {
  const validationOptions = {
    abortEarly: false,
    allowUnknown: false,
    stripUnknown: true,
  };

  const schemaKeys = {};
  const dataToValidate = {};

  if (schema.body) {
    schemaKeys.body = schema.body;
    dataToValidate.body = req.body;
  }
  if (schema.params) {
    schemaKeys.params = schema.params;
    dataToValidate.params = req.params;
  }
  if (schema.query) {
    schemaKeys.query = schema.query;
    dataToValidate.query = req.query;
  }

  const compiledSchema = Joi.object(schemaKeys);
  const { error, value } = compiledSchema.validate(dataToValidate, validationOptions);

  if (error) {
    const details = error.details.map((detail) => ({
      field: detail.path.join('.'),
      message: detail.message,
    }));

    return next(
      ApiError.badRequest('خطأ في البيانات المدخلة', 'VALIDATION_ERROR', details)
    );
  }

  if (value.body) req.body = value.body;
  if (value.params) req.params = value.params;
  if (value.query) req.query = value.query;

  next();
};

module.exports = validate;
